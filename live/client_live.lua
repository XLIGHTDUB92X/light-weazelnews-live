-- ============================================================
-- light-weazelnews-live - client_live.lua
-- ============================================================
-- The "Go Live" add-on for light-weazelnews. Drop this whole `live/`
-- folder (and the matching `ui/live/` folder) into your light-weazelnews
-- install - the base resource loads this file itself, dynamically, if
-- it's present, so there's nothing to register in fxmanifest.lua and
-- nothing else to configure. Config.LiveEnabled / Config.LivePlatforms /
-- Config.LivePollsEnabled (config.lua) already control it exactly like
-- before - this file reads that same Config table, since config.lua is
-- shared_script and loaded first.
--
-- This file is loaded via `load()` from light-weazelnews/client.lua, in
-- the SAME Lua environment as the rest of that resource - so it shares
-- globals with it (Config, TriggerServerCallback, etc.) exactly as if it
-- had been declared as a normal client_script. There's no extra wiring
-- needed beyond the file being present at this path.
-- ============================================================

RegisterNUICallback('goLive', function(data, cb)
    TriggerServerCallback('light-weazelnews:goLive', function(res)
        cb(res)
    end, data)
end)

RegisterNUICallback('endLive', function(_, cb)
    TriggerServerCallback('light-weazelnews:endLive', function(res)
        cb(res)
    end)
end)

RegisterNUICallback('joinLive', function(data, cb)
    TriggerServerCallback('light-weazelnews:joinLive', function(res)
        cb(res)
    end, data and data.citizenId)
end)

RegisterNUICallback('leaveLive', function(data, cb)
    TriggerServerCallback('light-weazelnews:leaveLive', function(res)
        cb(res)
    end, data and data.citizenId)
end)

RegisterNUICallback('getLiveBroadcasts', function(_, cb)
    TriggerServerCallback('light-weazelnews:getLiveBroadcasts', function(res)
        cb(res)
    end)
end)

RegisterNUICallback('sendLiveComment', function(data, cb)
    TriggerServerCallback('light-weazelnews:sendLiveComment', function(res)
        cb(res)
    end, data)
end)

RegisterNUICallback('likeLive', function(data, cb)
    TriggerServerCallback('light-weazelnews:likeLive', function(res)
        cb(res)
    end, data)
end)

RegisterNUICallback('startLivePoll', function(data, cb)
    TriggerServerCallback('light-weazelnews:startLivePoll', function(res)
        cb(res)
    end, data)
end)

RegisterNUICallback('voteLivePoll', function(data, cb)
    TriggerServerCallback('light-weazelnews:voteLivePoll', function(res)
        cb(res)
    end, data)
end)

RegisterNUICallback('endLivePoll', function(_, cb)
    TriggerServerCallback('light-weazelnews:endLivePoll', function(res)
        cb(res)
    end)
end)

RegisterNetEvent('light-weazelnews:client:liveStarted', function(data)
    SendNUIMessage({ action = 'liveStarted', citizenId = data.citizenId, authorName = data.authorName, title = data.title })
end)

RegisterNetEvent('light-weazelnews:client:liveEnded', function(citizenId)
    SendNUIMessage({ action = 'liveEnded', citizenId = citizenId })
end)

-- Only the BROADCASTER's own client ever receives this - server.lua only
-- ever targets it at a broadcast's own serverId. Keeps the "N watching"
-- readout in the Live tab's active bar current without any peer-connection
-- bookkeeping.
RegisterNetEvent('light-weazelnews:client:liveViewerCount', function(count)
    SendNUIMessage({ action = 'liveViewerCount', count = count })
end)

-- Only the BROADCASTER's own client ever receives this - server.lua only
-- ever targets it at a broadcast's own serverId.
RegisterNetEvent('light-weazelnews:client:liveComment', function(data)
    SendNUIMessage({ action = 'liveComment', authorName = data.authorName, body = data.body })
end)

-- Reaches BOTH the broadcaster and every current viewer (server.lua targets
-- it at each of them individually) so everyone's like count stays in sync
-- live, unlike liveComment above which is reporter-only.
RegisterNetEvent('light-weazelnews:client:liveLikeUpdate', function(likeCount)
    SendNUIMessage({ action = 'liveLikeUpdate', likeCount = likeCount })
end)

-- payload is nil when a poll ends/clears, or { question, options, counts }
RegisterNetEvent('light-weazelnews:client:livePollUpdate', function(payload)
    SendNUIMessage({ action = 'livePollUpdate', poll = payload })
end)
