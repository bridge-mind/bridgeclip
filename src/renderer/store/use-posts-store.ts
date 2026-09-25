import { create } from 'zustand'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import type { PostRecord } from '../../shared/zernio-posts'

export type PostAction = 'cancel' | 'reschedule' | 'retry' | 'dismiss'

interface PostsState {
  posts: PostRecord[]
  loaded: boolean
  refreshing: boolean
  /** A refresh or action that failed; the list itself is still current. */
  error: string | null
  /** Post id → the action running on it. */
  busy: Record<string, PostAction>
  load: () => Promise<void>
  /** Asks the main process to re-read posts whose status can still change. */
  refresh: (force?: boolean) => Promise<void>
  /** A post the dialog just created. */
  upsert: (post: PostRecord) => void
  cancel: (id: string) => Promise<boolean>
  reschedule: (id: string, scheduledFor: string, timezone: string) => Promise<boolean>
  retry: (id: string) => Promise<void>
  dismiss: (id: string) => Promise<void>
  open: (id: string, targetIndex: number) => void
  clearError: () => void
}

let refreshRequest: Promise<void> | null = null
// Older list responses must not replace a post created or changed while they ran.
let postsRevision = 0

export const usePostsStore = create<PostsState>((set, get) => {
  const run = async (id: string, action: PostAction, task: () => Promise<PostRecord[]>, fallback: string): Promise<boolean> => {
    if (get().busy[id]) return false
    set((state) => ({ busy: { ...state.busy, [id]: action }, error: null }))
    const startedAtRevision = postsRevision
    try {
      const posts = await task()
      if (postsRevision === startedAtRevision) {
        set({ posts })
      } else {
        // Another post may have been created or changed during this action.
        // Apply only this action's record instead of replacing the whole list.
        const changed = posts.find((post) => post.id === id)
        set((state) => ({ posts: changed
          ? [changed, ...state.posts.filter((post) => post.id !== id)]
          : state.posts.filter((post) => post.id !== id) }))
      }
      postsRevision += 1
      return true
    } catch (err) {
      set({ error: errorMessage(err, fallback) })
      // The action may have changed the post (e.g. it published meanwhile).
      const failedAtRevision = postsRevision
      getApi().zernio.posts.list().then((posts) => {
        if (postsRevision === failedAtRevision) {
          set({ posts })
          postsRevision += 1
        }
      }).catch(() => {})
      return false
    } finally {
      set((state) => {
        const busy = { ...state.busy }
        delete busy[id]
        return { busy }
      })
    }
  }

  return {
    posts: [],
    loaded: false,
    refreshing: false,
    error: null,
    busy: {},

    load: async () => {
      const startedAtRevision = postsRevision
      try {
        const posts = await getApi().zernio.posts.list()
        if (postsRevision === startedAtRevision) {
          set({ posts, loaded: true, error: null })
          postsRevision += 1
        } else set({ loaded: true })
      } catch (err) {
        if (postsRevision === startedAtRevision) set({ loaded: true, error: errorMessage(err, 'Could not read your post history.') })
        else set({ loaded: true })
      }
    },

    refresh: (force = false) => {
      // One refresh at a time: the main process spaces out its Zernio requests.
      refreshRequest ??= (async () => {
        set({ refreshing: true })
        const startedAtRevision = postsRevision
        try {
          const result = await getApi().zernio.posts.refresh(force)
          if (postsRevision === startedAtRevision) {
            set({ posts: result.posts, loaded: true, error: result.error })
            postsRevision += 1
          } else set({ loaded: true })
        } catch (err) {
          if (postsRevision === startedAtRevision) set({ error: errorMessage(err, 'Could not refresh your posts.') })
        } finally {
          set({ refreshing: false })
          refreshRequest = null
        }
      })()
      return refreshRequest
    },

    upsert: (post) => {
      postsRevision += 1
      set((state) => ({ posts: [post, ...state.posts.filter((p) => p.id !== post.id)], loaded: true }))
    },

    cancel: (id) => run(id, 'cancel', () => getApi().zernio.posts.cancel(id), 'Could not cancel the post.'),
    reschedule: (id, scheduledFor, timezone) =>
      run(id, 'reschedule', () => getApi().zernio.posts.reschedule(id, scheduledFor, timezone), 'Could not reschedule the post.'),
    retry: async (id) => {
      await run(id, 'retry', () => getApi().zernio.posts.retry(id), 'Could not retry the post.')
    },
    dismiss: async (id) => {
      await run(id, 'dismiss', () => getApi().zernio.posts.dismiss(id), 'Could not remove the post.')
    },

    open: (id, targetIndex) => {
      getApi().zernio.posts.open(id, targetIndex).catch((err) => set({ error: errorMessage(err, 'Could not open the post.') }))
    },

    clearError: () => set({ error: null })
  }
})
