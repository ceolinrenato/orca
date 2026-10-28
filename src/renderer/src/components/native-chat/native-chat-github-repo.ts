import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { resolveRepoSlug } from '@/lib/repo-slug-index'
import { readRepoSlugCache, repoSlugCacheKey, repoUpstreamIdentityKey } from '@/lib/repo-slug-cache'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  githubHostFromIdentityKey,
  githubRepoIdentityKey
} from '../../../../shared/github/repository-identity-key'

export type NativeChatGitHubRepo = {
  repo: Repo
  /** Origin then upstream identity keys; main only answers for these remotes. */
  identityKeys: readonly string[]
  /** Where bare `#123` points: upstream unless the repo prefers origin. github.com only. */
  referenceRepo: { owner: string; repo: string } | null
}

function readCachedOriginKey(repo: Repo | null): string | null {
  const cacheKey = repo ? repoSlugCacheKey(repo) : null
  const cached = cacheKey ? readRepoSlugCache(cacheKey) : null
  return cached?.hit ? cached.value : null
}

function ownerRepoFromKey(key: string): { owner: string; repo: string } | null {
  if (githubHostFromIdentityKey(key)) {
    return null
  }
  const [owner, repo] = key.split('/')
  return owner && repo ? { owner, repo } : null
}

/** The git repo behind the chat's workspace, with its GitHub remotes once resolved. */
export function useNativeChatGitHubRepo(
  worktreeId: string | undefined
): NativeChatGitHubRepo | null {
  const repo = useAppStore((state) => {
    const worktree = worktreeId ? findKnownWorktreeById(state, worktreeId) : null
    if (!worktree) {
      return null
    }
    // Route by the worktree's own host; an ambiguous repo id gets no cards rather than the focused host's.
    const owners = state.repos.filter(
      (candidate) =>
        candidate.id === worktree.repoId &&
        (!worktree.hostId || getRepoExecutionHostId(candidate) === worktree.hostId)
    )
    const found = owners.length === 1 ? owners[0] : null
    return found && (!found.kind || found.kind === 'git') ? found : null
  })
  const [resolved, setResolved] = useState(() => ({
    repo,
    originKey: readCachedOriginKey(repo)
  }))
  const originKey = resolved.repo === repo ? resolved.originKey : readCachedOriginKey(repo)

  useEffect(() => {
    if (!repo) {
      return
    }
    let cancelled = false
    void resolveRepoSlug(repo).then((key) => {
      if (!cancelled) {
        setResolved({ repo, originKey: key })
      }
    })
    return () => {
      cancelled = true
    }
  }, [repo])

  return useMemo(() => {
    if (!repo || !originKey) {
      return null
    }
    const upstreamKey = repoUpstreamIdentityKey(repo, originKey)
    const identityKeys =
      upstreamKey && upstreamKey !== originKey ? [originKey, upstreamKey] : [originKey]
    const referenceKey =
      upstreamKey && repo.issueSourcePreference !== 'origin' ? upstreamKey : originKey
    return {
      repo,
      identityKeys,
      referenceRepo: ownerRepoFromKey(referenceKey)
    }
  }, [repo, originKey])
}

export function githubLinkBelongsToRepo(
  repo: NativeChatGitHubRepo,
  slug: { owner: string; repo: string; host?: string }
): boolean {
  return repo.identityKeys.includes(githubRepoIdentityKey(slug))
}
