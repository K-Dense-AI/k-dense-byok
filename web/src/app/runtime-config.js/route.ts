export const dynamic = "force-dynamic";
export function GET() {
  const config = { apiBase: process.env.KADY_API_URL || process.env.NEXT_PUBLIC_ADK_API_URL, packaged: process.env.KADY_PACKAGED === "1" };
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  return new Response(`window.__KADY_RUNTIME__=${json};`, { headers: {
    "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
  } });
}
