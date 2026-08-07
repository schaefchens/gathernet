/**
 * Inline stroke icons. Deliberately hand-rolled rather than pulled from an icon
 * package or font: the app is served over an onion service and must make no
 * off-origin requests, and a whole icon dependency for a dozen glyphs is waste.
 * All of them inherit `currentColor` and size from the `size` prop.
 */
type IconProps = { size?: number; className?: string }

function svg(path: React.ReactNode, { size = 20, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  )
}

export const ChatIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M20 14a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" />
      <path d="M8 9h8M8 12h5" />
    </>,
    p,
  )

export const CommunityIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 6.5a2.5 2.5 0 0 1 0 5M18 20a5 5 0 0 0-2.5-4.3" />
    </>,
    p,
  )

export const ConnectIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M12 4.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM18 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
      <path d="M10.6 7.9 7.4 13.3M13.4 7.9l3.2 5.4M8 17h8" />
    </>,
    p,
  )

export const SettingsIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5" />
      <path d="M16 5.5v3M8 10.5v3M13 15.5v3" />
    </>,
    p,
  )

export const ShieldIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6l-7-3Z" />
      <path d="M10.5 12.2v-1.4a1.5 1.5 0 0 1 3 0v1.4" />
      <rect x="9.6" y="12.2" width="4.8" height="3.8" rx="0.8" />
    </>,
    p,
  )

export const LockIcon = (p: IconProps) =>
  svg(
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" />
    </>,
    p,
  )

export const SendIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M20 4 3.5 11.2l6.4 2.2 2.2 6.4L20 4Z" />
      <path d="m9.9 13.4 4-4" />
    </>,
    p,
  )

export const AttachIcon = (p: IconProps) =>
  svg(
    <path d="M17.5 10.5 11 17a3.5 3.5 0 0 1-5-5l7-7a2.5 2.5 0 0 1 3.5 3.5l-7 7a1.5 1.5 0 0 1-2-2l6.2-6.2" />,
    p,
  )

export const MicIcon = (p: IconProps) =>
  svg(
    <>
      <rect x="9.5" y="3" width="5" height="10" rx="2.5" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
    </>,
    p,
  )

export const EyeIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>,
    p,
  )

export const CloseIcon = (p: IconProps) => svg(<path d="m6 6 12 12M18 6 6 18" />, p)

export const MoreIcon = (p: IconProps) =>
  svg(
    <>
      <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </>,
    p,
  )

export const PinIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M9 3h6l-1 5 3.5 3.5H6.5L10 8 9 3Z" />
      <path d="M12 11.5V21" />
    </>,
    p,
  )

export const ChevronIcon = (p: IconProps) => svg(<path d="m9 5 7 7-7 7" />, p)

export const PlusIcon = (p: IconProps) => svg(<path d="M12 5v14M5 12h14" />, p)

export const CatalogIcon = (p: IconProps) =>
  svg(
    <>
      <rect x="3.5" y="4" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="4" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="14" width="7" height="6" rx="1.5" />
      <rect x="13.5" y="14" width="7" height="6" rx="1.5" />
    </>,
    p,
  )

export const SmileIcon = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8" />
      <path d="M9.2 9.5h.01M14.8 9.5h.01" strokeWidth="2" />
    </>,
    p,
  )

export const ReplyIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M9 7 4 12l5 5" />
      <path d="M4 12h9a6 6 0 0 1 6 6v1" />
    </>,
    p,
  )

export const EditIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M4 20h4l10-10a2.4 2.4 0 0 0-3.4-3.4L4.6 16.6 4 20Z" />
      <path d="M13.5 7.5 16.5 10.5" />
    </>,
    p,
  )

export const TrashIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7" />
      <path d="M6.5 6.5 7.4 19a1.4 1.4 0 0 0 1.4 1.3h6.4A1.4 1.4 0 0 0 16.6 19l.9-12.5" />
    </>,
    p,
  )

export const FlagIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M6 21V4" />
      <path d="M6 4.6h10.5l-1.8 3.6 1.8 3.6H6" />
    </>,
    p,
  )
