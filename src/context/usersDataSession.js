/** In-memory session — survives HMR / route changes until dev server stops */
export const usersDataSession = {
  loaded: false,
  loadPromise: null,
  overviewRows: [],
  withdrawalRequests: [],
  usersVal: null,
  lastSync: null,
}
