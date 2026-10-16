/** Whole server group-title budget, matching the providers' existing text-generation limit. */
export const TEXT_GENERATION_TIMEOUT_MS_FORK = 180_000;
/** Allow the server's failure response to arrive before the client aborts. */
export const THREAD_GROUP_TITLE_CLIENT_TIMEOUT_MS_FORK = TEXT_GENERATION_TIMEOUT_MS_FORK + 5_000;
