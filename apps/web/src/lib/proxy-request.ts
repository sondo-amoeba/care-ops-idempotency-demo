import { NextRequest } from "next/server";

export function apiBaseUrl(): string {
  return process.env.API_PROXY_URL ?? "http://localhost:3001";
}

export async function proxyToApi(request: NextRequest, apiPath: string): Promise<Response> {
  const target = new URL(apiPath, apiBaseUrl());
  target.search = request.nextUrl.search;

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }

  const res = await fetch(target, init);
  const body = await res.arrayBuffer();
  const outHeaders = new Headers();
  const responseType = res.headers.get("content-type");
  if (responseType) {
    outHeaders.set("content-type", responseType);
  }

  return new Response(body, { status: res.status, headers: outHeaders });
}
