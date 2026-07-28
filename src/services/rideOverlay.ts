import { Capacitor, registerPlugin } from '@capacitor/core'

export interface RideOverlayStatus {
  overlayPermission: boolean
  notificationAccess: boolean
  notificationsAllowed: boolean
  running: boolean
}

interface RideOverlayNative {
  getStatus(): Promise<RideOverlayStatus>
  openOverlaySettings(): Promise<void>
  openNotificationSettings(): Promise<void>
  start(options: { costPerKm: number; minPerKm: number }): Promise<RideOverlayStatus>
  stop(): Promise<RideOverlayStatus>
}

const Native = registerPlugin<RideOverlayNative>('RideOverlay')

export const rideOverlayAvailable = () => Capacitor.getPlatform() === 'android'
export const rideOverlay = Native
