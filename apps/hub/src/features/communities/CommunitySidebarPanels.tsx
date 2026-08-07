import type { CommunityDetailResponse } from '@gathernet/shared'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api.ts'
import { useSession } from '../../stores/session.ts'
import { InvitePanel } from './InvitePanel.tsx'
import { MemberPanel } from './MemberPanel.tsx'

/**
 * The people side of the community you have open, rendered in the app sidebar.
 *
 * Channels already live there; putting the member list beside them means the
 * community view is just "sidebar to navigate, main pane to read" — the same
 * shape as the chat screen — instead of a page competing with its own panels.
 * Shares the route's `['community', id]` query, so this costs no extra request.
 */
export function CommunitySidebarPanels({ communityId }: { communityId: string }) {
  const myAccountId = useSession((s) => s.accountId)
  const detail = useQuery({
    queryKey: ['community', communityId],
    queryFn: () => api<CommunityDetailResponse>('GET', `/api/v1/communities/${communityId}`),
  })

  const data = detail.data
  if (!data) return null
  const isLeader = data.myRole === 'owner' || data.myRole === 'leader'

  return (
    <div className="space-y-3">
      <MemberPanel
        communityId={communityId}
        myRole={data.myRole}
        myAccountId={myAccountId}
        members={data.members}
        memberCount={data.memberCount}
        memberBucket={data.memberBucket}
        channelIds={data.channels.map((c) => c.channelId)}
      />
      {isLeader && <InvitePanel communityId={communityId} />}
    </div>
  )
}
