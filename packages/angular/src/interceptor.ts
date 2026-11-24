import type { HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { from, switchMap } from "rxjs";

import { CANOPY_CLIENT, CANOPY_STATE } from "./provide-canopy";

/**
 * Attaches the access token as `Authorization: Bearer` to requests for the
 * origins listed in `provideCanopy({ apiOrigins })`, and to no other origin,
 * so the token never reaches a third party. A request that already carries
 * an `Authorization` header is left as it is.
 *
 *   provideHttpClient(withInterceptors([canopyAuthInterceptor]))
 */
export const canopyAuthInterceptor: HttpInterceptorFn = (request, next) => {
  const client = inject(CANOPY_CLIENT);
  const { apiOrigins } = inject(CANOPY_STATE);

  if (
    request.headers.has("Authorization") ||
    !apiOrigins.includes(originOf(request.url))
  ) {
    return next(request);
  }

  return from(client.getAccessToken()).pipe(
    switchMap((token) =>
      next(
        token
          ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
          : request,
      ),
    ),
  );
};

function originOf(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).origin;
  } catch {
    return "";
  }
}
