import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/github-work-item-source-lookup'
import type { GitHubIssueOrPRLink } from '../../../../shared/github/links'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Repo } from '../../../../shared/repo-types'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { buildTaskSourceContextFromRepo } from '../../../../shared/task-source-context'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'

const previews = createHoverPreviewCache<GitHubWorkItem>({ freshMs: 60_000, maxEntries: 200 })

function previewKey(repo: Repo, link: GitHubIssueOrPRLink): string {
  return `${repo.id}:${githubRepoIdentityKey(link.slug)}#${link.number}:${link.type}`
}

async function lookup(
  repo: Repo,
  link: GitHubIssueOrPRLink,
  type: 'issue' | 'pr'
): Promise<GitHubWorkItem | null> {
  return lookupGitHubWorkItemByOwnerRepoForSource({
    repoPath: repo.path,
    repoId: repo.id,
    sourceContext: buildTaskSourceContextFromRepo({
      provider: 'github',
      projectId: repo.id,
      repo
    }),
    owner: link.slug.owner,
    repo: link.slug.repo,
    host: link.slug.host,
    number: link.number,
    type,
    preview: true
  })
}

async function fetchPreview(repo: Repo, link: GitHubIssueOrPRLink): Promise<GitHubWorkItem | null> {
  const item = await lookup(repo, link, link.type)
  // Hosts without the preview lookup answer null for a PR asked for as an issue (bare #N links).
  return item || link.type !== 'issue' ? item : lookup(repo, link, 'pr')
}

/** Lets a reopened card paint its last answer without a loading frame. */
export function readCachedGitHubLinkPreview(
  repo: Repo,
  link: GitHubIssueOrPRLink
): GitHubWorkItem | null {
  return previews.read(previewKey(repo, link))
}

export function loadGitHubLinkPreview(
  repo: Repo,
  link: GitHubIssueOrPRLink
): Promise<GitHubWorkItem | null> {
  return previews.load(previewKey(repo, link), () => fetchPreview(repo, link))
}
