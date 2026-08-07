import type { CommunityDetailResponse } from '@gathernet/shared'
import { useTranslation } from 'react-i18next'
import type { CommunityMeta } from '../../lib/community-keys.ts'
import { Markdown } from '../../lib/markdown.tsx'
import { DESKTOP_QUERY, useMediaQuery } from '../../lib/use-media-query.ts'
import { ChannelList } from './ChannelList.tsx'
import { CommunityAvatar } from './CommunityAvatar.tsx'

/** Coarse size bands — literal i18n keys for the typed t(). */
const BUCKET_KEY = {
  few: 'communities.sizeFew',
  dozens: 'communities.sizeDozens',
  hundreds: 'communities.sizeHundreds',
  thousands: 'communities.sizeThousands',
  tensOfThousands: 'communities.sizeTensOfThousands',
  hundredsOfThousands: 'communities.sizeHundredsOfThousands',
} as const

/**
 * The community itself, shown when you open a community rather than one of its
 * channels: the mark, the name, and however much the organisers wrote about it.
 *
 * Descriptions are expected to be long — a church explaining who it is — so this
 * scrolls and renders the markdown in full instead of clamping it to a line above
 * a conversation. The channel list repeats here because on a phone there is no
 * sidebar to pick from.
 */
export function CommunityOverview({
  communityId,
  detail,
  meta,
}: {
  communityId: string
  detail: CommunityDetailResponse
  meta: CommunityMeta | null
}) {
  const { t } = useTranslation()
  const name = meta?.name ?? t('communities.encryptedName')
  const isDesktop = useMediaQuery(DESKTOP_QUERY)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-5 py-6">
        <header className="space-y-3 text-center">
          <div className="flex justify-center">
            <CommunityAvatar
              communityId={communityId}
              mediaId={detail.community.avatarMediaId}
              label={name}
              size="lg"
            />
          </div>
          <div>
            <h1 className="font-display text-3xl text-gold-bright">{name}</h1>
            <p className="mt-1 text-xs text-ink-faint">
              {detail.memberCount !== null
                ? t('communities.memberCount', { count: detail.memberCount })
                : t(BUCKET_KEY[detail.memberBucket])}
              {' · '}
              {t(`communities.roles.${detail.myRole}`)}
            </p>
          </div>
        </header>

        {meta?.description && (
          <div className="card">
            {/* Unclamped: this is the page whose job is the description, and a
                community's "who we are" is expected to run long. */}
            <Markdown
              text={meta.description}
              className="text-sm leading-relaxed text-ink-soft [&_a]:text-gold [&_a]:underline [&_li]:mb-1 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5"
            />
          </div>
        )}

        {/* Only where there is no sidebar to pick from — on desktop the channels are
            already listed beside this page. */}
        {!isDesktop && (
          <section className="card space-y-2">
            <h2 className="section-label">{t('communities.channels')}</h2>
            <ChannelList communityId={communityId} />
          </section>
        )}
      </div>
    </div>
  )
}
