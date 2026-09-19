import { expect, test } from "vitest";
import { nativeGitEnvironment } from "./native-git.js";

test("native git restores a service home when the plugin worker strips HOME", () => {
  const environment = nativeGitEnvironment({PATH: "/usr/bin"});
  expect(environment.HOME).toMatch(/^\//);
  expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
  expect(environment.PATH).toBe("/usr/bin");
});
