import { inject } from "@angular/core";
import type { CanActivateFn } from "@angular/router";

import { CANOPY_CLIENT } from "./provide-canopy";

/**
 * Admits a signed-in person. Anyone else is sent to Canopy's sign-in and
 * comes back to the page they were opening. Decides what the app shows; your
 * API still authorizes every request.
 */
export const canopyAuthGuard: CanActivateFn = (_route, state) => {
  const client = inject(CANOPY_CLIENT);
  const { status } = client.getSnapshot();

  if (status === "signed-in") {
    return true;
  }

  if (status === "signed-out") {
    void client.signIn({ returnTo: state.url });
  }

  // Still loading only when Canopy could not be reached; stay put.
  return false;
};
