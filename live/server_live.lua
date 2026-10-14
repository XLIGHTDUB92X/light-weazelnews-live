-- ============================================================
-- light-weazelnews-live - server_live.lua
-- ============================================================
-- The "Go Live" add-on for light-weazelnews. Drop this whole `live/`
-- folder (and the matching `ui/live/` folder) into your light-weazelnews
-- install - the base resource loads this file itself, dynamically, if
-- it's present, so there's nothing to register in fxmanifest.lua and
-- nothing else to configure. Config.LiveEnabled / Config.LivePlatforms /
-- Config.LivePollsEnabled / Config.LivePay* / Config.MaxLive* / etc. in
-- config.lua already control it exactly like before - this file reads
-- that same Config table, since config.lua is shared_script and loaded
-- first, before either half of this add-on.
--
-- This file is loaded via `load()` from light-weazelnews/server.lua, in
-- the SAME Lua environment as the rest of that resource, so it can call
-- GetPlayerJob / IsNewsReporter / IsSafeUrl / RegisterCallback /
-- SanitizeLen / PayReporter exactly like any other part of that resource
-- - those five (plus PayReporter) are declared as real globals there
-- specifically so this add-on can reach them. Nothing else needed.
-- ============================================================

-- The base resource's own canPost callback no longer sends
-- liveEnabled/livePlatforms/livePollsEnabled (it doesn't know about this
-- add-on at all) - ui/live/live.js calls THIS callback instead, once, to
-- get them. Kept separate rather than patching into canPost so this
-- add-on never has to touch base server.lua's response shape.
RegisterCallback('light-weazelnews:getLiveConfig', function(src)
    return {
        liveEnabled = Config.LiveEnabled,
        livePlatforms = Config.LivePlatforms,
        livePollsEnabled = Config.LivePollsEnabled,
    }
end)

-- A reporter goes live by pasting a link to a stream they're ALREADY
-- broadcasting on Twitch, Kick, YouTube, or TikTok (via OBS, Streamlabs,
-- the platform's own app, whatever they already use) - this resource
-- never touches a camera or microphone at all, it just embeds that
-- platform's own player for anyone who watches in-game. See
-- DetectStreamPlatform() below for exactly which links are accepted, and
-- the README's "Go Live" section for the per-platform embedding notes.
--
-- ActiveBroadcasts is deliberately in-memory only, never the database - a
-- broadcast is a live event, not content, and it should always end cleanly
-- the moment the resource restarts or the reporter disconnects rather than
-- being "resumed" from a stale row.
local ActiveBroadcasts = {} -- citizenId -> { serverId, authorName, title, platform, streamUrl, startedAt, viewers = { [identifier] = serverId }, likedBy = {}, likeCount = 0 }

---Figures out which supported platform a pasted link belongs to, purely
---from its hostname - NEVER trust a client-supplied "platform" field, only
---what the URL itself actually resolves to. Returns nil for anything else,
---including a platform that's been turned off via Config.LivePlatforms.
local function DetectStreamPlatform(url)
    if not IsSafeUrl(url) then return nil end

    local host = url:match('^https?://([^/]+)')
    if not host then return nil end
    host = host:lower()

    -- True if `host` is exactly `domain` or a subdomain of it (so
    -- 'www.twitch.tv' matches 'twitch.tv', but 'nottwitch.tv' does not).
    local function hostIs(domain)
        return host == domain or host:sub(-(#domain + 1)) == ('.' .. domain)
    end

    if Config.LivePlatforms.twitch and hostIs('twitch.tv') then return 'twitch' end
    if Config.LivePlatforms.kick and hostIs('kick.com') then return 'kick' end
    if Config.LivePlatforms.youtube and (hostIs('youtube.com') or hostIs('youtu.be')) then return 'youtube' end
    if Config.LivePlatforms.tiktok and hostIs('tiktok.com') then return 'tiktok' end

    return nil
end

local function FindLiveBroadcastByHost(src)
    for citizenId, b in pairs(ActiveBroadcasts) do
        if b.serverId == src then return citizenId, b end
    end
    return nil
end

-- Searches by the VIEWER'S SERVER ID (not their identifier) so this also
-- works during a playerDropped cleanup, where the framework's own player
-- data (and therefore GetPlayerJob) may already be gone.
local function FindLiveBroadcastByViewerServerId(src)
    for citizenId, b in pairs(ActiveBroadcasts) do
        for identifier, viewerSrc in pairs(b.viewers) do
            if viewerSrc == src then return citizenId, b, identifier end
        end
    end
    return nil
end

local function CountLiveViewers(broadcast)
    local n = 0
    for _ in pairs(broadcast.viewers) do n = n + 1 end
    return n
end

-- Lets the reporter's own client keep its "N watching" readout live,
-- without needing any peer-connection bookkeeping the way the old
-- WebRTC version did - this is now just a plain viewer-count push.
local function NotifyViewerCount(broadcast)
    TriggerClientEvent('light-weazelnews:client:liveViewerCount', broadcast.serverId, CountLiveViewers(broadcast))
end

-- Pays every currently-live reporter for the viewers they had, once per
-- minute. Deliberately keyed off viewer COUNT at payout time, not elapsed
-- broadcast time - a broadcast that just started still gets paid for its
-- first full minute of viewers, and a broadcast with nobody watching right
-- now is skipped entirely rather than paid $0 (no PayReporter call, no
-- wallet insert, nothing - see PayReporter's own amount <= 0 guard too).
CreateThread(function()
    while true do
        Wait(60000) -- 1 minute

        if Config.LivePayPerViewerPerMinute > 0 then
            for citizenId, broadcast in pairs(ActiveBroadcasts) do
                local viewerCount = CountLiveViewers(broadcast)
                if viewerCount > 0 then
                    PayReporter(citizenId, Config.LivePayPerViewerPerMinute * viewerCount, 'live')
                end
            end
        end
    end
end)

-- Tears down whatever `src` was doing live-wise (hosting or watching).
-- Used for both explicit endLive/leaveLive calls and player disconnects.
local function CleanupLiveForPlayer(src)
    local hostCitizenId, hostBroadcast = FindLiveBroadcastByHost(src)
    if hostBroadcast then
        ActiveBroadcasts[hostCitizenId] = nil
        TriggerClientEvent('light-weazelnews:client:liveEnded', -1, hostCitizenId)
        return
    end

    local _, viewedBroadcast, identifier = FindLiveBroadcastByViewerServerId(src)
    if viewedBroadcast then
        viewedBroadcast.viewers[identifier] = nil
        NotifyViewerCount(viewedBroadcast)
    end
end

AddEventHandler('playerDropped', function()
    CleanupLiveForPlayer(source)
end)

-- Start broadcasting. Only one active broadcast per reporter at a time.
-- The stream itself is already running on the platform before this is ever
-- called - this just tells the app to start showing/embedding it.
RegisterCallback('light-weazelnews:goLive', function(src, data)
    if not Config.LiveEnabled then
        return { success = false, error = 'Live broadcasting is disabled.' }
    end
    if not IsNewsReporter(src) then
        return { success = false, error = 'You do not have permission to go live.' }
    end

    local _, _, identifier, displayName = GetPlayerJob(src)
    if not identifier then
        return { success = false, error = 'Could not identify you.' }
    end

    if ActiveBroadcasts[identifier] then
        return { success = false, error = 'You are already live.' }
    end

    local streamUrl = SanitizeLen(data and data.streamUrl, 500)
    local platform = DetectStreamPlatform(streamUrl)
    if not platform then
        -- Hardcoded to match the *default* Config.LivePlatforms (TikTok
        -- off) - update this string too if you change which platforms are
        -- enabled above, since DetectStreamPlatform's actual accept list
        -- is config-driven but this message text isn't generated from it.
        return { success = false, error = 'Paste a valid Twitch, Kick, or YouTube link.' }
    end

    local title = SanitizeLen(data and data.title, 100)
    if title == '' then title = 'Live from the field' end

    local authorName = SanitizeLen(data and data.authorName, Config.MaxAuthorLength)
    if authorName == '' then authorName = displayName or 'Weazel News' end

    ActiveBroadcasts[identifier] = {
        serverId = src,
        authorName = authorName,
        title = title,
        platform = platform,
        streamUrl = streamUrl,
        startedAt = os.time(),
        viewers = {},
        likedBy = {}, -- [identifier] = true, once a viewer has liked this broadcast
        likeCount = 0,
        poll = nil, -- { question, options = {..}, counts = {..}, votedBy = { [identifier] = optionIndex } }
    }

    TriggerClientEvent('light-weazelnews:client:liveStarted', -1, {
        citizenId = identifier,
        authorName = authorName,
        title = title,
    })

    if Config.NotifyOnLive then
        TriggerClientEvent('light-weazelnews:client:notify', -1, 'Live Now', authorName .. ' is live: ' .. title)
    end

    return {
        success = true,
        citizenId = identifier,
        platform = platform,
        streamUrl = streamUrl,
        twitchEmbedParents = Config.TwitchEmbedParents,
    }
end)

-- Stop broadcasting (does NOT touch the actual stream on Twitch/etc. -
-- purely stops this app from showing/embedding it anymore).
RegisterCallback('light-weazelnews:endLive', function(src)
    local hostCitizenId, hostBroadcast = FindLiveBroadcastByHost(src)
    if not hostBroadcast then
        return { success = false, error = 'You are not live.' }
    end

    ActiveBroadcasts[hostCitizenId] = nil
    TriggerClientEvent('light-weazelnews:client:liveEnded', -1, hostCitizenId)
    return { success = true }
end)

-- A viewer wants to watch citizenId's broadcast - just hands back the
-- platform/link to embed. There's no connection to set up on our end at
-- all (unlike the old WebRTC version); the platform's own player does all
-- the real work, our iframe just points at it.
RegisterCallback('light-weazelnews:joinLive', function(src, citizenId)
    citizenId = citizenId and tostring(citizenId) or nil
    local broadcast = citizenId and ActiveBroadcasts[citizenId]
    if not broadcast then
        return { success = false, error = 'This broadcast has ended.' }
    end

    local _, _, identifier = GetPlayerJob(src)
    if not identifier then
        return { success = false, error = 'Could not identify you.' }
    end

    broadcast.viewers[identifier] = src
    NotifyViewerCount(broadcast)

    return {
        success = true,
        title = broadcast.title,
        authorName = broadcast.authorName,
        platform = broadcast.platform,
        streamUrl = broadcast.streamUrl,
        twitchEmbedParents = Config.TwitchEmbedParents,
        likeCount = broadcast.likeCount,
        liked = broadcast.likedBy[identifier] == true,
        poll = broadcast.poll and {
            question = broadcast.poll.question,
            options = broadcast.poll.options,
            counts = broadcast.poll.counts,
            voted = broadcast.poll.votedBy[identifier],
        } or nil,
    }
end)

-- A viewer is done watching (closed the viewer, or navigated away).
RegisterCallback('light-weazelnews:leaveLive', function(src, citizenId)
    citizenId = citizenId and tostring(citizenId) or nil
    local broadcast = citizenId and ActiveBroadcasts[citizenId]
    if not broadcast then return { success = true } end

    local _, _, identifier = GetPlayerJob(src)
    if identifier and broadcast.viewers[identifier] then
        broadcast.viewers[identifier] = nil
        NotifyViewerCount(broadcast)
    end

    return { success = true }
end)

-- A viewer sends a live comment. Relayed ONLY to the broadcasting
-- reporter's own client - never to other viewers, never stored anywhere -
-- see Config.LiveCommentsEnabled in config.lua for why. Only a broadcast's
-- CURRENT, actually-joined viewers can send to it.
RegisterCallback('light-weazelnews:sendLiveComment', function(src, data)
    if not Config.LiveCommentsEnabled then
        return { success = false, error = 'Live comments are disabled.' }
    end

    local citizenId = data and data.citizenId and tostring(data.citizenId) or nil
    local broadcast = citizenId and ActiveBroadcasts[citizenId]
    if not broadcast then
        return { success = false, error = 'This broadcast has ended.' }
    end

    local _, _, identifier, displayName = GetPlayerJob(src)
    if not identifier or broadcast.viewers[identifier] ~= src then
        return { success = false, error = 'You have to be watching to comment.' }
    end

    local body = SanitizeLen(data and data.body, Config.MaxLiveCommentLength)
    if body == '' then
        return { success = false, error = 'Comment cannot be empty.' }
    end

    TriggerClientEvent('light-weazelnews:client:liveComment', broadcast.serverId, {
        authorName = displayName or 'Viewer',
        body = body,
    })

    return { success = true }
end)

-- A viewer likes the broadcast they're currently watching. One like per
-- viewer per broadcast, tracked in-memory on the broadcast itself
-- (likedBy) - clicking again (or a duplicate/replayed request) is a no-op,
-- not a re-pay, so this can't be farmed by spamming the button. Pays
-- Config.LivePayPerLike to the reporter, same wallet/toast path as
-- everything else, and pushes the new count to the reporter AND every
-- current viewer so everyone's like count stays in sync live.
RegisterCallback('light-weazelnews:likeLive', function(src, data)
    if not Config.LiveEnabled then
        return { success = false, error = 'Live broadcasting is disabled.' }
    end

    local citizenId = data and data.citizenId and tostring(data.citizenId) or nil
    local broadcast = citizenId and ActiveBroadcasts[citizenId]
    if not broadcast then
        return { success = false, error = 'This broadcast has ended.' }
    end

    local _, _, identifier = GetPlayerJob(src)
    if not identifier or broadcast.viewers[identifier] ~= src then
        return { success = false, error = 'You have to be watching to like this.' }
    end

    if broadcast.likedBy[identifier] then
        return { success = true, likeCount = broadcast.likeCount, alreadyLiked = true }
    end

    broadcast.likedBy[identifier] = true
    broadcast.likeCount = broadcast.likeCount + 1

    if Config.LivePayPerLike > 0 then
        PayReporter(citizenId, Config.LivePayPerLike, 'live_like')
    end

    TriggerClientEvent('light-weazelnews:client:liveLikeUpdate', broadcast.serverId, broadcast.likeCount)
    for _, viewerSrc in pairs(broadcast.viewers) do
        TriggerClientEvent('light-weazelnews:client:liveLikeUpdate', viewerSrc, broadcast.likeCount)
    end

    return { success = true, likeCount = broadcast.likeCount }
end)

---Pushes the current poll state to the broadcaster and every current
---viewer - the same "reaches everyone watching" pattern as the like count.
local function BroadcastPollUpdate(broadcast)
    local payload = broadcast.poll and {
        question = broadcast.poll.question,
        options = broadcast.poll.options,
        counts = broadcast.poll.counts,
    } or nil -- nil payload = "poll ended/cleared"

    TriggerClientEvent('light-weazelnews:client:livePollUpdate', broadcast.serverId, payload)
    for _, viewerSrc in pairs(broadcast.viewers) do
        TriggerClientEvent('light-weazelnews:client:livePollUpdate', viewerSrc, payload)
    end
end

-- Reporter-only: starts a new poll on their OWN current broadcast,
-- replacing any poll already running.
RegisterCallback('light-weazelnews:startLivePoll', function(src, data)
    if not Config.LivePollsEnabled then return { success = false, error = 'Live polls are disabled.' } end

    local citizenId, broadcast = FindLiveBroadcastByHost(src)
    if not broadcast then return { success = false, error = 'You are not live.' } end

    local question = SanitizeLen(data and data.question, Config.MaxLivePollQuestionLength)
    if question == '' then return { success = false, error = 'A poll needs a question.' } end

    local options = {}
    if type(data and data.options) == 'table' then
        for _, opt in ipairs(data.options) do
            local clean = SanitizeLen(opt, Config.MaxLivePollOptionLength)
            if clean ~= '' and #options < Config.MaxLivePollOptions then
                options[#options + 1] = clean
            end
        end
    end
    if #options < 2 then return { success = false, error = 'A poll needs at least 2 options.' } end

    local counts = {}
    for i = 1, #options do counts[i] = 0 end

    broadcast.poll = { question = question, options = options, counts = counts, votedBy = {} }
    BroadcastPollUpdate(broadcast)

    return { success = true }
end)

-- Any current viewer can vote once per poll (a NEW startLivePoll call
-- resets votedBy, so a fresh poll can always be voted on again).
RegisterCallback('light-weazelnews:voteLivePoll', function(src, data)
    local citizenId = data and data.citizenId and tostring(data.citizenId) or nil
    local broadcast = citizenId and ActiveBroadcasts[citizenId]
    if not broadcast or not broadcast.poll then
        return { success = false, error = 'There is no poll running right now.' }
    end

    local _, _, identifier = GetPlayerJob(src)
    if not identifier or broadcast.viewers[identifier] ~= src then
        return { success = false, error = 'You have to be watching to vote.' }
    end

    if broadcast.poll.votedBy[identifier] then
        return { success = false, error = 'You already voted on this poll.' }
    end

    local optionIndex = tonumber(data.optionIndex)
    if not optionIndex or not broadcast.poll.options[optionIndex] then
        return { success = false, error = 'Invalid option.' }
    end

    broadcast.poll.votedBy[identifier] = optionIndex
    broadcast.poll.counts[optionIndex] = (broadcast.poll.counts[optionIndex] or 0) + 1
    BroadcastPollUpdate(broadcast)

    return { success = true, voted = optionIndex }
end)

-- Reporter-only: ends/clears the current poll early.
RegisterCallback('light-weazelnews:endLivePoll', function(src)
    local citizenId, broadcast = FindLiveBroadcastByHost(src)
    if not broadcast then return { success = false, error = 'You are not live.' } end
    if not broadcast.poll then return { success = false, error = 'No poll is running.' } end

    broadcast.poll = nil
    BroadcastPollUpdate(broadcast)

    return { success = true }
end)

-- Whatever's live right now, for anyone who opens the app after a
-- broadcast has already started (the liveStarted broadcast only reaches
-- clients that were already connected the moment it fired).
RegisterCallback('light-weazelnews:getLiveBroadcasts', function(src)
    local list = {}
    for citizenId, b in pairs(ActiveBroadcasts) do
        list[#list + 1] = { citizenId = citizenId, authorName = b.authorName, title = b.title }
    end
    return { success = true, broadcasts = list }
end)
