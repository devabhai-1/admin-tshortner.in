import { createContext, useContext } from 'react'

export const UsersDataContext = createContext({
  usersVal: null,
  overviewRows: [],
  withdrawalRequests: [],
  ready: false,
  fromCache: false,
  live: false,
  sessionLoaded: false,
  lastSync: null,
  updateTick: 0,
  streamProgress: null,
  allUsersLoaded: false,
  reloadBusy: false,
  fbConnecting: false,
  refreshUsersData: async () => {},
  refreshUser: async () => {},
})

export function useUsersData() {
  return useContext(UsersDataContext)
}
