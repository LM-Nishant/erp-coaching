/** Lets the REST service tell connected sockets about lifecycle changes without importing Socket.IO. */
export interface RealtimeBridge {
  sessionEnded(instituteId: number, liveSessionId: number): void;
  onlineUserIds(instituteId: number, liveSessionId: number): number[];
}

let bridge: RealtimeBridge = { sessionEnded: () => {}, onlineUserIds: () => [] };

export const setRealtimeBridge = (b: RealtimeBridge) => {
  bridge = b;
};
export const realtime = (): RealtimeBridge => bridge;
