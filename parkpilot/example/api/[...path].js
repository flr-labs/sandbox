import { handleApi } from "../server/api.mjs";

export default function handler(req, res) {
  const url = req.url || "/";
  if (!url.startsWith("/api")) {
    const path = url.startsWith("/") ? url : `/${url}`;
    req.url = `/api${path}`;
  }
  return handleApi(req, res);
}
