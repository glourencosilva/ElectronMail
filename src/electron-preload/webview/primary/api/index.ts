import {EMPTY, Observable, from, interval, merge} from "rxjs";
import {buffer, concatMap, debounceTime, distinctUntilChanged, filter, map, mergeMap, tap} from "rxjs/operators";
import {omit, pick} from "remeda";
import {serializeError} from "serialize-error";

import * as RestModel from "src/electron-preload/webview/lib/rest-model";
import * as WebviewConstants from "src/electron-preload/webview/lib/constants";
import {AJAX_SEND_NOTIFICATION$} from "src/electron-preload/webview/primary/notifications";
import {IpcMainServiceScan} from "src/shared/api/main";
import {ONE_SECOND_MS, WEB_VIEW_SESSION_STORAGE_KEY_SKIP_LOGIN_DELAYS} from "src/shared/constants";
import {PROTONMAIL_IPC_WEBVIEW_API, ProtonApi, ProtonNotificationOutput} from "src/shared/api/webview/primary";
import {PROTONMAIL_MAILBOX_IDENTIFIERS} from "src/shared/model/database";
import {PROTONMAIL_MAILBOX_ROUTE_NAMES} from "./constants";
import {angularJsHttpResponseTypeGuard, isLoggedIn} from "src/electron-preload/webview/primary/util";
import {buildDbPatch, buildDbPatchEndpoint} from "src/electron-preload/webview/primary/api/build-db-patch";
import {curryFunctionMembers, isEntityUpdatesPatchNotEmpty} from "src/shared/util";
import {dumpProtonSharedSession} from "src/electron-preload/webview/primary/shared-session";
import {
    fillInputValue,
    getLocationHref,
    resolveDomElements,
    resolveIpcMainApi,
    submitTotpToken,
} from "src/electron-preload/webview/lib/util";
import {resolveProviderApi} from "src/electron-preload/webview/primary/provider-api";

const _logger = curryFunctionMembers(WebviewConstants.WEBVIEW_LOGGERS.primary, "[api/index]");

const endpoints: ProtonApi = {
    ...buildDbPatchEndpoint,

    async ping() {}, // eslint-disable-line @typescript-eslint/no-empty-function

    async selectMailOnline(input) {
        _logger.info("selectMailOnline()", input.zoneName);

        // TODO reduce the "mailFolderId" value that contains a minimum items count
        const $state: undefined | { // eslint-disable-line @typescript-eslint/no-unsafe-assignment
            go: (
                path: string,
                params?: Partial<Record<"label" | "id" | "messageID", string>>,
            ) => Promise<void>;
        } = (
            window.angular
            &&
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
            window.angular.element(document).data().$injector.get("$state")
        );

        if (!$state) {
            throw new Error(`Failed to resolve "$state" service`);
        }

        const api = await resolveProviderApi();
        const messagesViewMode = api.mailSettingsModel.get().ViewMode === api.constants.MESSAGE_VIEW_MODE;
        const {system, custom} = input.mail.mailFolderIds.reduce(
            (accumulator: {
                 system: Mutable<typeof input.mail.mailFolderIds>;
                 custom: Mutable<typeof input.mail.mailFolderIds>;
             },
             id,
            ) => {
                if (id in PROTONMAIL_MAILBOX_ROUTE_NAMES) {
                    accumulator.system.push(id);
                } else {
                    accumulator.custom.push(id);
                }
                return accumulator;
            },
            {
                system: [],
                custom: [],
            },
        );
        const {id: mailId, conversationEntryPk: mailConversationId} = input.mail;

        if (custom.length) {
            const [folderId] = custom;

            if (messagesViewMode) {
                await $state.go(`secured.label.element`, {
                    id: mailId,
                    label: folderId,
                });
            } else {
                await $state.go("secured.label", {
                    label: folderId,
                });
                await $state.go("secured.label.element", {
                    id: mailConversationId,
                    messageID: mailId,
                });
            }

            return;
        }

        type RouteNameKey = Unpacked<typeof PROTONMAIL_MAILBOX_ROUTE_NAMES._.names>;

        const folderRouteName = system.length > 1
            ? (() => {
                const folderId = system.find((id) => id !== PROTONMAIL_MAILBOX_IDENTIFIERS["All Mail"]) as RouteNameKey | undefined;
                if (!folderId) {
                    throw new Error(`Failed to resolve folder`);
                }
                return PROTONMAIL_MAILBOX_ROUTE_NAMES[folderId];
            })()
            : PROTONMAIL_MAILBOX_ROUTE_NAMES[system[0] as RouteNameKey];

        if (!folderRouteName) {
            throw new Error(`Failed to resolve folder route name`);
        }

        if (messagesViewMode) {
            await $state.go(`secured.${folderRouteName}.element`, {
                id: mailId,
            });
        } else {
            await $state.go(`secured.${folderRouteName}.element`, {
                id: mailConversationId,
                messageID: mailId,
            });
        }
    },

    async makeMailRead(input) {
        _logger.info("makeMailRead()", input.zoneName);

        const {message} = await resolveProviderApi();

        await message.read({IDs: input.messageIds});

        // TODO consider triggering the "refresh" action (clicking the "refresh" button action)
    },

    async setMailFolder(input) {
        _logger.info("setMailFolder()", input.zoneName);

        const {message} = await resolveProviderApi();

        await message.label({LabelID: input.folderId, IDs: input.messageIds});

        // TODO consider triggering the "refresh" action (clicking the "refresh" button action)
    },

    async exportMailAttachments({uuid, mailPk, login, zoneName}) {
        const logger = curryFunctionMembers(_logger, "exportMailAttachments()", zoneName);

        logger.info();

        const ipcMain = await resolveIpcMainApi(_logger);
        const dbMessage = await ipcMain("dbGetAccountMail")({pk: mailPk, login});
        const rawMessage: RestModel.Message = JSON.parse(dbMessage.raw); // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        const {attachmentLoader} = await resolveProviderApi();
        const loadedAttachments: Mutable<IpcMainServiceScan["ApiImplArgs"]["dbExportMailAttachmentsNotification"][0]["attachments"]> = [];

        for (const attachment of rawMessage.Attachments) {
            const template = {Headers: attachment.Headers} as const;

            try {
                loadedAttachments.push({
                    ...template,
                    data: await attachmentLoader.get(attachment, rawMessage),
                });
            } catch (error) {
                /* eslint-disable max-len */
                // TODO live attachments export: process "error.data" case:
                //      see https://github.com/ProtonMail/WebClient/blob/15bd4af2e5a4b695991cc8633b2304d2f9d4d99e/src/app/attachments/services/attachmentDownloader.js#L197 ("formatDownload" function)
                /* eslint-enable max-len */
                const serializedError = serializeError(
                    // sanitizing the error (original error might include the "data"/other props which we don't want to log)
                    pick(error, ["name", "message", "stack", "code"]), // eslint-disable-line @typescript-eslint/no-unsafe-member-access
                );

                logger.error("attachment loading failed", JSON.stringify({index: loadedAttachments.length}), serializedError);

                // TODO live attachments export: skip failed calls so export process
                //      doesn't get cancelled (display skipped mails on the UI)
                loadedAttachments.push({
                    ...template,
                    serializedError: serializeError(serializedError),
                });
            }
        }

        if (dbMessage.attachments.length !== loadedAttachments.length) {
            throw new Error(
                [
                    `Invalid attachments content items array length (`,
                    `expected/db: ${String(dbMessage.attachments.length)}; actual/loaded: ${String(loadedAttachments.length)}`,
                    `)`,
                ].join(""),
            );
        }

        await ipcMain("dbExportMailAttachmentsNotification")({
            uuid,
            accountPk: {login},
            attachments: loadedAttachments,
        });
    },

    async fillLogin({login, zoneName}) {
        const logger = curryFunctionMembers(_logger, "fillLogin()", zoneName);

        logger.info();

        const elements = await resolveDomElements(
            {
                username: () => document.getElementById("username") as HTMLInputElement,
            },
            logger,
        );
        logger.verbose(`elements resolved`);

        fillInputValue(elements.username, login);
        logger.verbose(`input values filled`);

        elements.username.readOnly = true;
    },

    async login({login, password, zoneName}) {
        const logger = curryFunctionMembers(_logger, "login()", zoneName);

        logger.info();

        await endpoints.fillLogin({login, zoneName});
        logger.verbose(`fillLogin() executed`);

        const elements = await resolveDomElements(
            {
                password: () => document.getElementById("password") as HTMLInputElement,
                submit: () => document.getElementById("login_btn") as HTMLElement,
            },
            logger,
        );
        logger.verbose(`elements resolved`);

        if (elements.password.value) {
            throw new Error(`Password is not supposed to be filled already on "login" stage`);
        }

        fillInputValue(elements.password, password);
        logger.verbose(`input values filled`);

        elements.submit.click();
        logger.verbose(`clicked`);
    },

    async login2fa({secret, zoneName}) {
        const logger = curryFunctionMembers(_logger, "login2fa()", zoneName);

        logger.info();

        const resolveElementsConfig = {
            input: () => document.getElementById("twoFactorCode") as HTMLInputElement,
            button: () => document.getElementById("login_btn_2fa") as HTMLElement,
        };
        const elements = await resolveDomElements(resolveElementsConfig, logger);

        logger.verbose("elements resolved");

        return submitTotpToken(
            elements.input,
            elements.button,
            async () => {
                const ipcMainApiClient = await resolveIpcMainApi(logger);
                const response = await ipcMainApiClient("generateTOTPToken")({secret});
                return response.token;
            },
            logger,
            {
                submittingDetection: async () => {
                    try {
                        await resolveDomElements(resolveElementsConfig, logger, {iterationsLimit: 1});
                    } catch {
                        return true;
                    }
                    return false;
                },
            },
        );
    },

    async unlock({mailPassword, zoneName}) {
        const logger = curryFunctionMembers(_logger, "unlock()", zoneName);

        logger.info("unlock()", zoneName);

        const elements = await resolveDomElements(
            {
                mailboxPassword: () => document.getElementById("mailboxPassword") as HTMLInputElement,
                submit: () => document.getElementById("unlock_btn") as HTMLElement,
            },
            logger,
        );

        fillInputValue(elements.mailboxPassword, mailPassword);
        elements.submit.click();
    },

    async resolveSavedProtonClientSession() {
        return dumpProtonSharedSession();
    },

    notification({entryUrl, entryApiUrl, zoneName}) {
        const logger = curryFunctionMembers(_logger, "notification()", zoneName);

        logger.info();

        type LoggedInOutput = Required<Pick<ProtonNotificationOutput, "loggedIn">>;
        type PageTypeOutput = Required<Pick<ProtonNotificationOutput, "pageType">>;
        type UnreadOutput = Required<Pick<ProtonNotificationOutput, "unread">>;
        type BatchEntityUpdatesCounterOutput = Required<Pick<ProtonNotificationOutput, "batchEntityUpdatesCounter">>;

        const observables: [
            Observable<LoggedInOutput>,
            Observable<PageTypeOutput>,
            Observable<UnreadOutput>,
            Observable<BatchEntityUpdatesCounterOutput>
        ] = [
            interval(WebviewConstants.NOTIFICATION_LOGGED_IN_POLLING_INTERVAL).pipe(
                map(() => isLoggedIn()),
                distinctUntilChanged(),
                map((loggedIn) => ({loggedIn})),
                tap(({loggedIn}) => {
                    if (loggedIn) {
                        window.sessionStorage.removeItem(WEB_VIEW_SESSION_STORAGE_KEY_SKIP_LOGIN_DELAYS);
                    }
                }),
            ),

            // TODO listen for location.href change instead of starting polling interval
            interval(WebviewConstants.NOTIFICATION_PAGE_TYPE_POLLING_INTERVAL).pipe(
                map((() => {
                    const formIdToPageTypeMappingEntries = (() => {
                        const formIdToPageTypeMapping: Record<string, PageTypeOutput["pageType"]["type"]> = {
                            pm_login: "login", // eslint-disable-line @typescript-eslint/naming-convention
                            pm_loginTwoFactor: "login2fa", // eslint-disable-line @typescript-eslint/naming-convention
                            pm_loginUnlock: "unlock", // eslint-disable-line @typescript-eslint/naming-convention
                        };
                        return Object.entries(formIdToPageTypeMapping);
                    })();
                    const loginUrl = `${entryUrl}/login`;

                    return () => {
                        const url = getLocationHref();
                        const pageType: PageTypeOutput["pageType"] = {url, type: "unknown"};

                        if (
                            !isLoggedIn()
                            &&
                            url === loginUrl
                        ) {
                            for (const [formId, type] of formIdToPageTypeMappingEntries) {
                                const form = document.getElementById(formId);
                                const formVisible = form && form.offsetParent;

                                if (formVisible) {
                                    pageType.type = type;
                                    break;
                                }
                            }
                        }

                        return {pageType};
                    };
                })()),
                distinctUntilChanged(({pageType: prev}, {pageType: curr}) => curr.type === prev.type),
                map((value) => {
                    if (value.pageType.type !== "login") {
                        return value;
                    }

                    const pageType: typeof value.pageType = {
                        ...value.pageType,
                        skipLoginDelayLogic: Boolean(
                            window.sessionStorage.getItem(WEB_VIEW_SESSION_STORAGE_KEY_SKIP_LOGIN_DELAYS),
                        ),
                    };

                    window.sessionStorage.removeItem(WEB_VIEW_SESSION_STORAGE_KEY_SKIP_LOGIN_DELAYS);

                    return {pageType};
                }),
            ),

            (() => {
                const responseListeners = [
                    {
                        re: new RegExp(`${entryApiUrl}/api/messages/count`),
                        handler: ({Counts}: { Counts?: Array<{ LabelID: string; Unread: number }> }) => {
                            if (!Counts) {
                                return;
                            }
                            return Counts
                                .filter(({LabelID}) => LabelID === "0")
                                .reduce((accumulator, item) => accumulator + item.Unread, 0);
                        },
                    },
                    {
                        re: new RegExp(`${entryApiUrl}/api/events/.*==`),
                        handler: ({MessageCounts}: RestModel.EventResponse) => {
                            if (!MessageCounts) {
                                return;
                            }
                            return MessageCounts
                                .filter(({LabelID}) => LabelID === "0")
                                .reduce((accumulator, item) => accumulator + item.Unread, 0);
                        },
                    },
                ] as const;

                return AJAX_SEND_NOTIFICATION$.pipe(
                    mergeMap((request) => responseListeners
                        .filter(({re}) => {
                            return re.test(request.responseURL);
                        })
                        .reduce(
                            (accumulator, {handler}) => {
                                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                                const responseData = JSON.parse(request.responseText);
                                const value = handler(responseData);

                                return typeof value === "number"
                                    ? accumulator.concat([{unread: value}])
                                    : accumulator;
                            },
                            [] as UnreadOutput[],
                        )),
                    distinctUntilChanged((prev, curr) => curr.unread === prev.unread),
                );
            })(),

            (() => {
                const innerLogger = curryFunctionMembers(logger, `[entity update notification]`);
                const eventsUrlRe = new RegExp(entryApiUrl + "/api/events/.*==");
                const notification = {batchEntityUpdatesCounter: 0};
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                const notificationReceived$: Observable<RestModel.EventResponse> = AJAX_SEND_NOTIFICATION$.pipe(
                    filter((request) => eventsUrlRe.test(request.responseURL)),
                    map((request) => {
                        return JSON.parse(request.responseText); // eslint-disable-line @typescript-eslint/no-unsafe-return
                    }),
                );

                return notificationReceived$.pipe(
                    buffer(notificationReceived$.pipe(
                        debounceTime(ONE_SECOND_MS * 1.5),
                    )),
                    concatMap((events) => from(buildDbPatch({events, parentLogger: innerLogger}, true))),
                    concatMap((patch) => {
                        if (!isEntityUpdatesPatchNotEmpty(patch)) {
                            return EMPTY;
                        }
                        for (const key of (Object.keys(patch) as Array<keyof typeof patch>)) {
                            innerLogger.verbose(`upsert/remove ${key}: ${patch[key].upsert.length}/${patch[key].remove.length}`);
                        }
                        notification.batchEntityUpdatesCounter++;
                        return [notification];
                    }),
                );
            })(),
        ];

        return merge(...observables).pipe(
            tap((notification) => logger.verbose(JSON.stringify({notification}))),
        );
    },
};

export function registerApi(): void {
    PROTONMAIL_IPC_WEBVIEW_API.register(
        endpoints,
        {
            logger: {
                ..._logger,
                error: (
                    ...args: any[] // eslint-disable-line @typescript-eslint/no-explicit-any
                ) => {
                    _logger.error(
                        ...args.map((arg) => {
                            if (angularJsHttpResponseTypeGuard(arg)) {
                                return {
                                    // omitting possibly sensitive properties
                                    ...omit(arg, ["config", "headers", "data"]),
                                    url: arg.config && arg.config.url,
                                };
                            }
                            return arg; // eslint-disable-line @typescript-eslint/no-unsafe-return
                        }),
                    );
                },
            },
        },
    );

    _logger.verbose(`api registered, url: ${getLocationHref()}`);
}
