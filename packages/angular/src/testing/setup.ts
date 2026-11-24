// Just-in-time compilation, so TestBed can compile the directives' and the
// test hosts' templates without the Angular build.
import "@angular/compiler";

import { getTestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";

getTestBed().initTestEnvironment(
  BrowserTestingModule,
  platformBrowserTesting(),
);
