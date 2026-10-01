import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const bar = (x: number, y: number, h: number, color: string) => (
  <div style={{ position: "absolute", left: x, top: y, width: 22, height: h, borderRadius: 5, background: color }} />
);

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", background: "#0b0e13", position: "relative", display: "flex" }}>
        {bar(36, 84, 52, "#ea3943")}
        {bar(79, 62, 56, "#16c784")}
        {bar(122, 34, 62, "#16c784")}
      </div>
    ),
    size,
  );
}
