import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** PNG home-screen icon (iOS ignores SVG icons): the same mark as app/icon.svg. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="180" height="180">
        <rect width="28" height="28" fill="#111111" />
        <path d="M9 7h7l4 4v10H9z" fill="#fafaf7" />
        <path d="M16 7v4h4z" fill="#d7f75b" />
        <path d="M11.5 14.5h6M11.5 17.5h4" stroke="#111111" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
    size,
  );
}
