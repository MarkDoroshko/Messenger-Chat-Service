import { WebSocket } from 'ws'

// watcherWs → набор userId, за которыми эта сессия следит
const subsByWs = new Map<WebSocket, Set<string>>()
// observedUserId → набор сессий, ожидающих об нём апдейтов
const watchersByUser = new Map<string, Set<WebSocket>>()

export function subscribe(ws: WebSocket, userIds: string[]): string[] {
    let mine = subsByWs.get(ws)
    if (!mine) { mine = new Set(); subsByWs.set(ws, mine) }

    const added: string[] = []
    for (const id of userIds) {
        if (mine.has(id)) continue
        mine.add(id)
        let observers = watchersByUser.get(id)
        if (!observers) { observers = new Set(); watchersByUser.set(id, observers) }
        observers.add(ws)
        added.push(id)
    }
    return added
}

export function unsubscribe(ws: WebSocket, userIds: string[]): void {
    const mine = subsByWs.get(ws)
    if (!mine) return
    for (const id of userIds) {
        mine.delete(id)
        const observers = watchersByUser.get(id)
        if (observers) {
            observers.delete(ws)
            if (observers.size === 0) watchersByUser.delete(id)
        }
    }
    if (mine.size === 0) subsByWs.delete(ws)
}

export function cleanupSession(ws: WebSocket): void {
    const mine = subsByWs.get(ws)
    if (!mine) return
    for (const id of mine) {
        const observers = watchersByUser.get(id)
        if (observers) {
            observers.delete(ws)
            if (observers.size === 0) watchersByUser.delete(id)
        }
    }
    subsByWs.delete(ws)
}

export function getWatchersOf(userId: string): Set<WebSocket> | undefined {
    return watchersByUser.get(userId)
}
