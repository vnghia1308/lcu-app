
"use strict"

const { request, authenticate, connect, LeagueClient } = require('league-connect')
const { dialog, app, BrowserWindow, ipcMain, desktopCapturer } = require('electron')
const fs = require('fs'), xl = require('excel4node'), exec = require('child_process').exec, axios = require('axios'), https = require('https')
var fse = require("fs-extra")

app.commandLine.appendSwitch('ignore-certificate-errors')

/**
 * @global
 */
const IS_PRODUCTION = false
const APP_VERSION = "3.0.0-20230812"

/**
 * General data
 */
var IsFirstStart = true, SummonerName = null, IsRunAsAdmin = false, SummonerId = null, AutoSelectChampion = {
    status: false,
    championId: 0,
    banChampionId: 0,
    Advanced: {
        State: false,
        PerkId: 0
    },
    AutoChat: ""
}, AutoAcceptMatch = false

// exec('NET SESSION', function (err, so, se) {
//     IsRunAsAdmin = !se.includes("Access is denied")

//     if (!IsRunAsAdmin) {
//         dialog.showMessageBox({
//             type: 'error',
//             buttons: ['OK'],
//             defaultId: 1,
//             title: 'Error',
//             message: 'Cannot start this app',
//             detail: 'Please run app as administrator (because LeagueClient.exe is an administrator proccess)'
//         }).then(() => {
//             app.quit()
//         })
//     }
// })

// const ShareLCUId = uuidv4()
// const { io } = require("socket.io-client")

// const socket = io("https://realtime.vynghia.org:3000?id=" + ShareLCUId + "&from=app", { rejectUnauthorized: false })

// socket.on("connect", () => {
//     console.log("connect to socket")
// })

// socket.on("send-lcu-request", async (event, method, url, body = {}) => {
//     try {
//         const credentials = await authenticate()
//         const response = await request({
//             method,
//             url,
//             body
//         }, credentials)

//         var resp = await response.text()

//         try {
//             resp = JSON.parse(resp)
//         } catch {
//             resp = { success: true, data: resp }
//         }

//         socket.emit("lcu-response", event, url, resp)
//     } catch (error) {
//         console.log(error)
//         socket.emit("lcu-error", event, url)
//     }
// })

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @private
 **/
async function StartGamePhaseListener(credentials) {
    const ws = await connect(credentials)

    const GetPhaseSession = async () => {
        const response = await request({
            method: 'GET',
            url: '/lol-champ-select/v1/session'
        }, credentials)

        return await response.json()
    }

    const AcceptMatch = async () => {
        const response = await request({
            method: 'POST',
            url: '/lol-matchmaking/v1/ready-check/accept'
        }, credentials)

        return await response.json()
    }

    const SendMatchMessage = async (roomId, message) => {
        const response = await request({
            method: 'POST',
            url: `/lol-chat/v1/conversations/${roomId}/messages`,
            body: {
                body: message
            }
        }, credentials)

        return await response.json()
    }

    const PickChampion = async (matchSession = null, pickChampionId = null, banChampionId = null) => {
        if (pickChampionId == -1)
            return

        let cellId = null
        if ("myTeam" in matchSession) {
            for (let team of matchSession["myTeam"]) {
                if (team.summonerId == SummonerId) {
                    cellId = team.cellId
                    break
                }
            }
        }

        let actionId = null
        if ("actions" in matchSession && cellId != null) {
            for (let action of matchSession["actions"][0]) {
                if (action.actorCellId == cellId) {
                    actionId = action.id
                    break
                }
            }
        }

        if (actionId) {
            /**
             * @event on-Select-Champion-inPicking
             * @state Final
             */
            const SelectChampion = async () => {
                const actionUrl = '/lol-champ-select/v1/session/actions/' + actionId
                await request({
                    method: 'PATCH',
                    url: actionUrl,
                    body: {
                        "championId": pickChampionId
                    }
                }, credentials)

                const confirmSelectChampion = await request({
                    method: 'POST',
                    url: actionUrl + "/complete"
                }, credentials)

                return confirmSelectChampion
            }

            /**
             * @event on-Select-Champion-toFinish
             * @state Final
             */
            await SelectChampion()
        }
    }

    const onChampionSelect = async () => {
        const matchSession = await GetPhaseSession()

        /**
         * @event on-Auto-Champion-Select
         * @state Final
         */
        await PickChampion(matchSession, AutoSelectChampion.championId, AutoSelectChampion.banChampionId)

        /**
         * @event on-Auto-Custom-Perk
         * @state Final
         */
        if (AutoSelectChampion.Advanced.State) {
            var data = JSON.stringify(AutoSelectChampion.Advanced.PerkId)
            var config = {
                method: 'put',
                url: `https://127.0.0.1:${credentials.port}/lol-perks/v1/currentpage`,
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(`riot:${credentials === null || credentials === void 0 ? void 0 : credentials.password}`).toString('base64'),
                    'Content-Type': 'application/json'
                },
                data: data,
                httpsAgent: new https.Agent({
                    rejectUnauthorized: false
                })
            }

            await axios(config)
        }

        /**
         * @event on-Auto-Champ-Select-Chat
         * @state InBeta
         */
        if (AutoSelectChampion.AutoChat.trim() != "") {
            for (const roomMessage of AutoSelectChampion.AutoChat.split("\n")) {
                if (!(/[a-zA-Z0-9]/.test(roomMessage)))
                    continue

                await sleep(1000)

                const
                    chatDetails = matchSession.chatDetails,
                    roomId = chatDetails.chatRoomName.split('@')[0]

                await SendMatchMessage(roomId, roomMessage)
            }
        }
    }

    ws.subscribe('/lol-gameflow/v1/gameflow-phase', async (data, event) => {
        //SendSocket("onGameStateChange", data)

        if (data == "ReadyCheck" && AutoAcceptMatch)
            await AcceptMatch()

        if (data == "ChampSelect" && AutoSelectChampion.status)
            await onChampionSelect()
    })
}

async function StartLeagueClientListener(credentials) {
    // const client = new LeagueClient(credentials)

    // client.on('disconnect', () => {
    //     app.quit()
    // })

    // client.start()
}

ipcMain.on('request-mainprocess-action', (event, arg) => {
    switch (arg.type) {
        case "get_stream":
            desktopCapturer.getSources({ types: ['window'] }).then(async sources => {
                for (const source of sources) {
                    if (source.name == "League of Legends")
                        event.sender.send("on-detected-stream", source.id)
                }
            })
            break

        case "select_champion":
            (async function () {
                const credentials = await authenticate()

                const GetPhaseSession = async () => {
                    const response = await request({
                        method: 'GET',
                        url: '/lol-champ-select/v1/session'
                    }, credentials)

                    return await response.json()
                }

                const AcceptMatch = async () => {
                    const response = await request({
                        method: 'POST',
                        url: '/lol-matchmaking/v1/ready-check/accept'
                    }, credentials)

                    return await response.json()
                }

                const PickChampion = async (pickChampionId = null) => {
                    if (pickChampionId == -1)
                        return

                    let matchSession = await GetPhaseSession()

                    let cellId = null
                    if ("myTeam" in matchSession) {
                        for (let team of matchSession["myTeam"]) {
                            if (team.summonerId == SummonerId) {
                                cellId = team.cellId
                                break
                            }
                        }
                    }

                    let actionId = null
                    if ("actions" in matchSession && cellId != null) {
                        for (let session of matchSession["actions"]) {
                            for (let action of session) {
                                if (action.actorCellId == cellId && action.completed == false) {
                                    actionId = action.id
                                    break
                                }
                            }
                        }

                    }

                    if (actionId) {
                        const selectChampion = async () => {
                            const actionUrl = '/lol-champ-select/v1/session/actions/' + actionId
                            await request({
                                method: 'PATCH',
                                url: actionUrl,
                                body: {
                                    "championId": pickChampionId
                                }
                            }, credentials)

                            const confirmSelectChampion = await request({
                                method: 'POST',
                                url: actionUrl + "/complete"
                            }, credentials)

                            return confirmSelectChampion
                        }

                        await selectChampion()
                    }
                }

                await PickChampion(arg.target)
            })()
            break

        /** @memberof change_background **/
        case "change_background":
            (async function () {
                try {
                    const credentials = await authenticate()

                    await request({
                        method: 'POST',
                        url: '/lol-summoner/v1/current-summoner/summoner-profile',
                        body: {
                            "key": "backgroundSkinId",
                            "value": parseInt(arg.skin_id)
                        }
                    }, credentials)

                    event.sender.send('mainprocess-response', "Đã gửi yêu cầu tới máy chủ cục bộ của Liên Minh")
                    event.sender.send('mainprocess-response-json', {
                        skin_id: arg.skin_id,
                        success: "true"
                    })
                } catch {
                    event.sender.send('mainprocess-response-json', {
                        skin_id: "null",
                        success: "false"
                    })

                    event.sender.send('mainprocess-response-error', "Không tìm thấy LeagueClient.exe hoạt động")
                }
            })()
            break

        /** @memberof get_skins_list **/
        case "get_skins_list":
            (async function () {
                try {
                    const credentials = await authenticate()

                    const response = await request({
                        method: 'GET',
                        url: '/lol-catalog/v1/items/CHAMPION_SKIN'
                    }, credentials)

                    let resJson = await response.json()
                    event.sender.send('mainprocess-response', "Đã gửi yêu cầu tới máy chủ cục bộ của Liên Minh")

                    resJson = resJson.filter(x => x.owned == true && x.name != "" && x.subInventoryType == "")

                    /**
                     * Remove duplicates
                     */
                    let SkinsList = []
                    for (let object of resJson) {
                        if (SkinsList.find(x => x.name.trim() == object.name.trim()) != null) {
                            continue
                        }

                        SkinsList.push(object)
                    }


                    event.sender.send('mainprocess-response-skin', `Đã nhận danh sách trang phục. Bạn đang sở hữu <strong>${SkinsList.length}</strong> trang phục`)

                    const wb = new xl.Workbook()
                    const ws = wb.addWorksheet('LCU Result')

                    const headingColumnNames = [
                        "#",
                        "Tên trang phục",
                        "Giá trang phục",
                        "Là di sản hoặc giới hạn?",
                        "Ngày sở hữu"
                    ]

                    let headingColumnIndex = 1
                    headingColumnNames.forEach(heading => {
                        ws.cell(1, headingColumnIndex++).string(heading)
                    })

                    let rowIndex = 2, index = 0;
                    for (let skin of SkinsList) {
                        let skin_prices = 0

                        let findPrices = SkinsList.find(x => x.itemId == skin.itemId && x.prices.length > 0)
                        if (typeof findPrices != "undefined") {
                            skin_prices = findPrices.prices[0].cost
                        }

                        let purchasedTime = (new Date(SkinsList.find(x => x.itemId == skin.itemId).purchaseDate * 1000)).toLocaleString("vi-vn", { timeZone: "Asia/Ho_Chi_Minh" }).replace(/\,/, " ")
                        purchasedTime = purchasedTime.split("  ")
                        let purchasedDate = purchasedTime[1]
                        purchasedDate = purchasedDate.split("/").map(x => {
                            return (parseInt(x) < 10) ? "0" + x : x
                        })

                        ws.cell(rowIndex, 1).number(++index)
                        ws.cell(rowIndex, 2).string(skin.name)
                        ws.cell(rowIndex, 3).number(skin_prices)
                        ws.cell(rowIndex, 4).string((skin.active) ? "Không" : "Có")
                        ws.cell(rowIndex, 5).string(`${purchasedTime[0].trim()} ${purchasedDate.join("/")}`)

                        rowIndex++

                    }

                    if (!fs.existsSync("./export")) {
                        fs.mkdirSync("./export")
                    }

                    wb.write(`./export/${SummonerName}-Skins-List-${(new Date()).getTime()}.xlsx`)

                    event.sender.send('mainprocess-response', "Danh sách trang phục đã được tạo")
                } catch {
                    event.sender.send('mainprocess-response-error', "Không tìm thấy LeagueClient.exe hoạt động")
                }
            })()
            break

        /** @memberof get_loot_value **/
        case "get_loot_analyst":
            (async function () {
                try {
                    const credentials = await authenticate()

                    const response = await request({
                        method: 'GET',
                        url: '/lol-loot/v1/player-loot'
                    }, credentials)

                    let resJson = await response.json()

                    /** 
                     * @alias [S]kins
                     * @alias [W]ards
                     * @alias [E]motes
                     **/
                    let
                        totalS = {
                            RP: 0,
                            OE: 0,
                            SK: 0
                        },
                        totalW = {
                            RP: 0,
                            OE: 0,
                            WR: 0
                        },
                        totalE = {
                            RP: 0,
                            OE: 0,
                            EM: 0
                        },
                        skinRarity = {
                            MYTHIC: 0,
                            ULTIMATE: 0,
                            LEGENDARY: 0,
                            EPIC: 0,
                            DEFAULT: 0
                        }

                    for (let item of resJson) {
                        if (item.displayCategories == "SKIN") {
                            totalS.SK += item.count
                            totalS.RP += item.value
                            totalS.OE += item.disenchantValue

                            skinRarity[item.rarity] += (1 * item.count)
                        }

                        if (item.displayCategories == "WARDSKIN") {
                            totalW.WR += item.count
                            totalW.RP += item.value
                            totalW.OE += item.disenchantValue
                        }

                        if (item.displayCategories == "EMOTE") {
                            totalE.EM += item.count
                            totalE.RP += item.value
                            totalE.OE += item.disenchantValue
                        }
                    }

                    event.sender.send('mainprocess-analyst-result', {
                        totalS, totalW, totalE, skinRarity
                    })

                    event.sender.send('mainprocess-response', "Hoàn thành thống kê")
                } catch {
                    event.sender.send('mainprocess-response-error', "Không tìm thấy LeagueClient.exe hoạt động")
                }
            })()
            break

        /** @memberof auto_select_champion **/
        case "request_start_auto_champ_select":
            AutoSelectChampion.status = true
            AutoSelectChampion.championId = arg.championId

            AutoAcceptMatch = arg.AutoAcceptMatch

            AutoSelectChampion.Advanced.State = arg.Advanced.State
            AutoSelectChampion.Advanced.PerkId = arg.Advanced.PerkId

            AutoSelectChampion.AutoChat = arg.AutoChat

            event.sender.send('mainprocess-response', "Đã khởi động auto")
            break

        /** @memberof auto-select-champ.html **/
        case "request_stop_auto_champ_select":
            AutoSelectChampion.status = false
            AutoSelectChampion.championId = 0

            event.sender.send('mainprocess-response', "Đã tạm dừng auto")
            break

        case "get_auto_champ_select_data":
            const data = {
                status: AutoSelectChampion.status,
                chat: AutoSelectChampion.AutoChat,
                advanced: AutoSelectChampion.Advanced.State
            }

            event.sender.send('mainprocess-response-asc-data', data)
            break

        /** @memberof match-history.html **/
        case "request_summoner_match_history":
            (async function () {
                try {
                    const credentials = await authenticate()

                    // Check & get summoner data
                    const response = await request({
                        method: 'GET',
                        url: '/lol-summoner/v1/summoners?name=' + arg.summonerName
                    }, credentials)

                    const summoner = await response.json()

                    if (!("accountId" in summoner))
                        return event.sender.send('mainprocess-response-error', "Người chơi không tồn tại")

                    matchHistoryWindow(["--match_history_puuid=" + summoner.puuid])
                } catch (error) {
                    event.sender.send('mainprocess-response-error', "Không thể kết nối tới trò chơi. Vui lòng khởi động (lại) Liên Minh Huyền thoại")
                }
            })()
            break

        /** @memberof match-history.html **/
        case "request_summoner_match_history_from_puuid":
            (async function () {
                try {
                    const credentials = await authenticate()

                    const requestMatch = await request({
                        method: 'GET',
                        url: `/lol-match-history/v1/products/lol/${arg.data.puuid}/matches?begIndex=${arg.data.beg}&endIndex=${arg.data.end}`
                    }, credentials)

                    const match = await requestMatch.json()

                    event.sender.send('mainprocess-match-reuslt', match)
                } catch (error) {
                    event.sender.send('mainprocess-response-error', "Không thể kết nối tới trò chơi. Vui lòng khởi động (lại) Liên Minh Huyền thoại")
                }
            })()
            break

        /** @memberof match-history.html **/
        case "get_match_data":
            (async function () {
                try {
                    const credentials = await authenticate()

                    const requestMatch = await request({
                        method: 'GET',
                        url: '/lol-match-history/v1/games/' + arg.matchId
                    }, credentials)

                    const match = await requestMatch.json()

                    event.sender.send('mainprocess-match-reuslt', match)
                } catch (error) {
                    event.sender.send('mainprocess-response-error', "Không thể kết nối tới trò chơi. Vui lòng khởi động (lại) Liên Minh Huyền thoại")
                }
            })()
            break

        /** @memberof edit-account-status.html */
        case "change_account_info":
            (async function () {
                try {
                    var PutQuery = {}

                    if (arg.data.RankTier != "none") {
                        PutQuery["lol"] = {
                            "rankedLeagueTier": arg.data.RankTier,
                            "rankedLeagueDivision": "I"
                        }
                    }

                    if (arg.data.StatusText != "") {
                        PutQuery["statusMessage"] = arg.data.StatusText
                    }

                    const credentials = await authenticate()
                    await request({
                        method: 'PUT',
                        url: '/lol-chat/v1/me',
                        body: PutQuery
                    }, credentials)

                    event.sender.send('mainprocess-response', "Thay đổi đã được lưu")
                } catch (error) {
                    event.sender.send('mainprocess-response-error', "Không thể kết nối tới trò chơi. Vui lòng khởi động (lại) Liên Minh Huyền thoại")
                }
            })()
            break


        case "request_perks_pages":
            (async function () {
                try {
                    const credentials = await authenticate()
                    const response = await request({
                        method: 'GET',
                        url: '/lol-perks/v1/pages'
                    }, credentials)

                    event.sender.send('mainprocess-response-perks', await response.json())
                } catch (error) {
                    event.sender.send('mainprocess-response-error', "Không thể kết nối tới trò chơi để yêu cầu bảng ngọc")
                }
            })()
            break

        /** @memberof un-all-friends.html */
        case "un_all_friends":
            (async function () {
                try {
                    const credentials = await authenticate()
                    const ExceptList = arg.data.ExceptList.split('\n').map(x => x.trim()).filter(x => x != "")

                    const frequest = await request({
                        method: 'GET',
                        url: '/lol-chat/v1/friends'
                    }, credentials)
                    const friends = await frequest.json()

                    for (const friend of friends) {
                        if (ExceptList.includes(friend.gameName))
                            continue

                        await request({
                            method: 'DELETE',
                            url: '/lol-chat/v1/friends/' + friend.puuid
                        }, credentials)

                        await sleep(1000)
                    }

                    event.sender.send('mainprocess-response', "Thao tác đã được thực hiện")
                } catch (error) {
                    console.log(error)
                    event.sender.send('mainprocess-response-error', "Không thể kết nối tới trò chơi. Vui lòng khởi động (lại) Liên Minh Huyền thoại")
                }
            })()
            break

        case "voice_changer_uninstall":
            try {
                if (!fs.existsSync(arg.data.gameFolder)) {
                    return event.sender.send('mainprocess-response-status', `Trạng thái: <strong style="color: red;">OOPS!</strong> Không tìm thấy thư mục game`)
                }

                // 
                try {
                    fs.unlinkSync(arg.data.gameFolder + "\\Game\\DATA\\FINAL\\UI." + arg.data.lang + ".wad.client")
                    fs.unlinkSync(arg.data.gameFolder + "\\LeagueClient\\Plugins\\rcp-fe-lol-typekit\\" + arg.data.lang + "-assets.wad")
                    fs.unlinkSync(arg.data.gameFolder + "\\LeagueClient\\Plugins\\rcp-be-lol-game-data\\" + arg.data.lang + "-assets.wad")
                } catch { }

                fse.copy("original\\system.yaml", arg.data.gameFolder + "\\Riot Client\\system.yaml", function (error) {
                    if (error) {
                        return event.sender.send('mainprocess-response-status', `Trạng thái: <strong style="color: red;">OOPS!</strong> Đã có lỗi khi ghi đè <strong>system.yaml</strong>`)
                    }
                })

                fs.readdir(arg.data.gameFolder + "\\Game\\DATA\\FINAL\\Champions", (err, files) => {
                    if (err) {
                        return event.sender.send('mainprocess-response-status', `Trạng thái: <strong style="color: red;">OOPS!</strong> Đã có lỗi xảy ra khi cố gắng truy cập thư mục <strong>Champions</strong>`)
                    }

                    for (const file of files) {
                        if (file.includes(arg.data.lang)) {
                            try {
                                fs.unlinkSync(arg.data.gameFolder + "\\Game\\DATA\\FINAL\\Champions\\" + file)
                            } catch { }
                        }
                    }

                    fs.readdir(arg.data.gameFolder + "\\Game\\DATA\\FINAL\\Localized", (err, files_2) => {
                        if (err) {
                            return event.sender.send('mainprocess-response-status', `Trạng thái: <strong style="color: red;">OOPS!</strong> Đã có lỗi xảy ra khi cố gắng truy cập thư mục <strong>Localized</strong>`)
                        }

                        for (const file of files_2) {
                            if (file.includes(arg.data.lang)) {
                                try {
                                    fs.unlinkSync(arg.data.gameFolder + "\\Game\\DATA\\FINAL\\Localized\\" + file)
                                } catch { }
                            }
                        }

                        fs.readdir(arg.data.gameFolder + "\\Game\\DATA\\FINAL\\Maps\\Shipping", (err, files_3) => {
                            if (err) {
                                return event.sender.send('mainprocess-response-status', `Trạng thái: <strong style="color: red;">OOPS!</strong> Đã có lỗi xảy ra khi cố gắng truy cập thư mục <strong>Maps\\Shipping</strong>`)
                            }

                            for (const file of files_3) {
                                if (file.includes(arg.data.lang)) {
                                    try {
                                        fs.unlinkSync(arg.data.gameFolder + "\\Game\\DATA\\FINAL\\Maps\\Shipping\\" + file)
                                    } catch { }
                                }
                            }

                            event.sender.send('mainprocess-response-status', `Trạng thái: <strong style="color: green;">DONE!</strong> Ngôn ngữ đã được gỡ cài đặt`)
                        })
                    })
                })
            } catch (error) {
                console.log(error)
                event.sender.send('mainprocess-response-error', "Đã có lỗi xảy ra")
            }
            break

        /** @memberof voice-changer.html */
        case "voice_changer_select":
            (async function () {
                try {
                    if (arg.data == "folder") {
                        dialog.showOpenDialog(null, {
                            "title": "Select Game Folder",
                            properties: ['openDirectory']
                        }).then(result => {
                            if (!result.canceled) {
                                event.sender.send('mainprocess-response-game-folder', result.filePaths)
                            }
                        })
                    } else {
                        dialog.showOpenDialog(null, {
                            "title": "Select Language Patch file",
                            "properties": ["openFile"],
                            "filters":
                                [
                                    {
                                        "name": "Zip File Only",
                                        "extensions": ["zip"]
                                    },
                                ],
                        }).then(result => {
                            if (!result.canceled) {
                                event.sender.send('mainprocess-response-patch-file', result.filePaths)
                            }
                        })
                    }
                } catch {
                    event.sender.send('mainprocess-response-error', "Đã có lỗi xảy ra")
                }
            })()
            break

        case "request_summoner":
            (async function () {
                try {
                    const credentials = await authenticate()
                    const response = await request({
                        method: 'GET',
                        url: '/lol-summoner/v1/current-summoner'
                    }, credentials)

                    const summoner = await response.json()

                    {
                        //Just testing

                        // const loot = await request({
                        //     method: 'GET',
                        //     url: '/lol-loot/v1/player-loot'
                        // }, credentials)

                        // fs.writeFileSync("test.json", JSON.stringify(await loot.json()))

                        // const auth = await request({
                        //     method: 'GET',
                        //     url: '/lol-rso-auth/v1/authorization/access-token'
                        // }, credentials)

                        //console.log(await auth.json())
                    }

                    SummonerId = summoner.summonerId
                    SummonerName = summoner.gameName

                    if (summoner.unnamed) {
                        SummonerName = "Không xác định"
                    }

                    if (typeof SummonerName == "undefined" || SummonerName == "undefined" || SummonerName == "") {
                        if (!summoner.unnamed) {
                            throw Error("undefined SummonerName")
                        }
                    }

                    if (IsFirstStart) {
                        StartGamePhaseListener(credentials)
                        StartLeagueClientListener(credentials)
                    }

                    IsFirstStart = false

                    event.sender.send('mainprocess-response-lcu', credentials)
                    event.sender.send('mainprocess-response-summoner', SummonerName)
                } catch (error) {
                    event.sender.send('mainprocess-response-error', "Vui lòng khởi động Liên Minh Huyền thoại")

                    let interval = setInterval(async () => {
                        try {
                            const credentials = await authenticate()

                            const response = await request({
                                method: 'GET',
                                url: '/lol-summoner/v1/current-summoner'
                            }, credentials)

                            const summoner = await response.json()

                            SummonerName = summoner.gameName

                            if (typeof SummonerName != "undefined" && SummonerName != "undefined" && SummonerName != "") {
                                SummonerId = summoner.summonerId

                                if (IsFirstStart) {
                                    StartGamePhaseListener(credentials)
                                    StartLeagueClientListener(credentials)
                                }

                                IsFirstStart = false

                                event.sender.send('mainprocess-response-summoner', SummonerName)

                                clearInterval(interval)
                            }
                        } catch { }
                    }, 3000)
                }
            })()
            break

        case "request_summoner_lcu_id":
            (async function () {
                try {
                    event.sender.send('mainprocess-response-summoner-lcu-id', ShareLCUId)
                } catch {

                }
            })()
            break
    }
});

function createWindow(url) {
    const win = new BrowserWindow({
        width: 1100,
        height: 900,
        resizable: true,
        title: "Loading...",
        backgroundColor: '#2c3e50',
        webPreferences: {
            webSecurity: false,
            nodeIntegration: true,
            contextIsolation: false
        }
    })

    win.on('close', function () {
        app.quit()
    })

    win.setMenu(null)
    win.loadURL((IS_PRODUCTION ? url.concat("?v=") : 'http://localhost:3000?v=') + APP_VERSION)

    if (!IS_PRODUCTION) {
        win.webContents.openDevTools()
    }
}

function matchHistoryWindow(query) {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        resizable: true,
        title: "Loading...",
        backgroundColor: '#2c3e50',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            additionalArguments: query
        }
    })

    win.maximize()

    win.setMenu(null)
    win.loadFile('./stats/match-list.html')
}

app.whenReady().then(async () => {
    try {
        const res = await axios.get("https://vnghia1308.github.io/lcu/app.config.json")
        const config = res.data

        createWindow(config.app_url)
    } catch {
        app.quit()
    }
})

app.on('uncaughtException', function (err) {
    fs.writeFileSync("error.dump", err)
})

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit()
})