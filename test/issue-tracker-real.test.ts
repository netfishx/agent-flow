import { describe, expect, test } from "bun:test";
import {
  classifyGhFailure,
  RealIssueTracker,
} from "../src/issue/real-tracker.ts";
import { ghArgvBuilders } from "../src/issue/gh-argv.ts";
import {
  IssueTrackerError,
  type IssueTracker,
} from "../src/issue/tracker.ts";

const authorizedTarget = {
  owner: "netfishx",
  repo: "agent-flow",
  number: 26,
} as const;

interface RecordedCommand {
  readonly argv: readonly string[];
  readonly stdin: string | null;
}

function recordingRunner(
  results: readonly {
    readonly stdout: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  }[],
): {
  readonly calls: RecordedCommand[];
  readonly run: (
    argv: readonly string[],
    stdin: string | null,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
} {
  const calls: RecordedCommand[] = [];
  let index = 0;
  return {
    calls,
    async run(argv, stdin) {
      calls.push({ argv: [...argv], stdin });
      const result = results[index++];
      if (result === undefined) throw new Error("unexpected command");
      return {
        stdout: result.stdout,
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
  };
}

describe("classifyGhFailure", () => {
  test.each([
    [500, true],
    [503, true],
    [429, true],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
  ])("classifies HTTP %d retryable=%s", (status, retryable) => {
    const error = classifyGhFailure(
      "resolve issue",
      `gh: request failed (HTTP ${status})`,
    );
    expect(error).toBeInstanceOf(IssueTrackerError);
    expect(error.retryable).toBe(retryable);
    expect(error.reason).toBe(
      `issue tracker resolve issue failed (HTTP ${status})`,
    );
  });

  test("treats a 403 secondary rate limit or retry-after as retryable", () => {
    expect(
      classifyGhFailure(
        "create comment",
        "secondary rate limit exceeded (HTTP 403)",
      ).retryable,
    ).toBe(true);
    expect(
      classifyGhFailure(
        "create comment",
        "please retry-after 60 seconds (HTTP 403)",
      ).retryable,
    ).toBe(true);
  });

  test("treats process, network, and DNS failures without HTTP status as retryable", () => {
    for (const stderr of [
      "",
      "dial tcp: network is unreachable",
      "lookup api.github.com: no such host",
    ]) {
      expect(
        classifyGhFailure("resolve issue", stderr).retryable,
      ).toBe(true);
    }
  });

  test("does not leak stderr into the reason", () => {
    const secret = "ghp_SENTINEL";
    const error = classifyGhFailure(
      "resolve issue",
      `${secret} (HTTP 404)`,
    );
    expect(error.reason).toBe(
      "issue tracker resolve issue failed (HTTP 404)",
    );
    expect(error.reason).not.toContain(secret);
  });
});

describe("RealIssueTracker target boundary", () => {
  test("requires one valid authorized target at construction", () => {
    expect(
      () =>
        new RealIssueTracker(
          {} as ConstructorParameters<typeof RealIssueTracker>[0],
        ),
    ).toThrow(IssueTrackerError);
    expect(
      () =>
        new RealIssueTracker({
          authorizedTarget: {
            owner: "netfishx",
            repo: "..",
            number: 26,
          },
          run: recordingRunner([]).run,
        }),
    ).toThrow(IssueTrackerError);
  });

  test("resolves the authorized issue through the expected argv and parser", async () => {
    const runner = recordingRunner([
      { stdout: '{"node_id":"I_kwDOB7"}' },
    ]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.resolveIssue({
        owner: "NetFishX",
        repo: "Agent-Flow",
        number: 26,
      }),
    ).resolves.toEqual({ nodeId: "I_kwDOB7" });
    expect(runner.calls).toEqual([
      {
        argv: [
          "api",
          "repos/netfishx/agent-flow/issues/26",
          "--method",
          "GET",
        ],
        stdin: null,
      },
    ]);
  });

  test.each([
    ["owner", { owner: "someone", repo: "agent-flow", number: 26 }],
    ["repo", { owner: "netfishx", repo: "other", number: 26 }],
    ["number", { owner: "netfishx", repo: "agent-flow", number: 27 }],
  ])("refuses a differing %s before running a command", async (_field, ref) => {
    const runner = recordingRunner([]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(tracker.resolveIssue(ref)).rejects.toMatchObject({
      name: "IssueTrackerError",
      retryable: false,
    });
    expect(runner.calls).toHaveLength(0);
  });

  test("checks the target allowlist before every capability", async () => {
    const runner = recordingRunner([]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });
    const other = {
      owner: "netfishx",
      repo: "agent-flow",
      number: 27,
    } as const;

    for (const operation of [
      () => tracker.resolveIssue(other),
      () =>
        tracker.findCommentByMarker(
          other,
          "<!-- agent-flow:delivery:run-26:1:start -->",
        ),
      () => tracker.createComment(other, "body"),
      () => tracker.readCurrentLabels(other),
      () =>
        tracker.compareAndSetTriageLabel(
          other,
          "ready-for-agent",
          "needs-info",
        ),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        name: "IssueTrackerError",
        retryable: false,
      });
    }
    expect(runner.calls).toHaveLength(0);
  });

  test.each([
    { owner: "netfishx", repo: "agent-flow", number: 6 },
    { owner: "NETFISHX", repo: "AGENT-FLOW", number: 6 },
  ])("refuses issue #6 at construction: %o", (target) => {
    expect(
      () =>
        new RealIssueTracker({
          authorizedTarget: target,
          run: recordingRunner([]).run,
        }),
    ).toThrow(IssueTrackerError);
  });

  test("refuses issue #6 on every operation regardless of configuration", async () => {
    const runner = recordingRunner([]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });
    const forbidden = {
      owner: "NETFISHX",
      repo: "AGENT-FLOW",
      number: 6,
    } as const;
    for (const operation of [
      () => tracker.resolveIssue(forbidden),
      () =>
        tracker.findCommentByMarker(
          forbidden,
          "<!-- agent-flow:delivery:run-26:1:start -->",
        ),
      () => tracker.createComment(forbidden, "body"),
      () => tracker.readCurrentLabels(forbidden),
      () =>
        tracker.compareAndSetTriageLabel(
          forbidden,
          "ready-for-agent",
          "needs-info",
        ),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        name: "IssueTrackerError",
        retryable: false,
      });
    }
    expect(runner.calls).toHaveLength(0);
  });

  test("rejects an unsafe target before any command or escaped path exists", async () => {
    const runner = recordingRunner([]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.resolveIssue({
        owner: "netfishx",
        repo: "..",
        number: 24,
      }),
    ).rejects.toMatchObject({
      name: "IssueTrackerError",
      retryable: false,
    });
    expect(runner.calls).toHaveLength(0);
    expect(
      runner.calls.some(({ argv }) =>
        argv.some((arg) => arg.includes("repos/netfishx/../issues/24")),
      ),
    ).toBe(false);
  });

  test("keeps compare-and-set writes on the authorized target after the caller mutates its ref", async () => {
    const ref: { owner: string; repo: string; number: number } = {
      ...authorizedTarget,
    };
    const calls: RecordedCommand[] = [];
    let callIndex = 0;
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: async (argv, stdin) => {
        calls.push({ argv: [...argv], stdin });
        if (callIndex++ === 0) {
          ref.number = 999;
          return {
            stdout: '{"labels":[{"name":"ready-for-agent"}]}',
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "[]", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      tracker.compareAndSetTriageLabel(
        ref,
        "ready-for-agent",
        "needs-info",
      ),
    ).resolves.toBe("applied");
    expect(calls.map(({ argv }) => argv[1])).toEqual([
      "repos/netfishx/agent-flow/issues/26",
      "repos/netfishx/agent-flow/issues/26/labels",
      "repos/netfishx/agent-flow/issues/26/labels/ready-for-agent",
    ]);
  });

  test("keeps create-comment on the authorized target across caller aliasing", async () => {
    let numberReads = 0;
    const ref = {
      owner: "netfishx",
      repo: "agent-flow",
      get number() {
        numberReads++;
        return numberReads <= 5 ? 26 : 999;
      },
    };
    const calls: RecordedCommand[] = [];
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: async (argv, stdin) => {
        calls.push({ argv: [...argv], stdin });
        ref.repo = "retargeted";
        return {
          stdout: JSON.stringify({
            id: 99,
            html_url:
              "https://github.com/netfishx/agent-flow/issues/26#issuecomment-99",
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });

    await tracker.createComment(ref, "body");
    expect(calls[0]?.argv[1]).toBe(
      "repos/netfishx/agent-flow/issues/26/comments",
    );
  });
});

describe("RealIssueTracker marker lookup", () => {
  const marker = "<!-- agent-flow:delivery:run-26:1:start -->";
  const underscoreMarker =
    "<!-- agent-flow:delivery:run_1:2:start -->";
  const dotMarker =
    "<!-- agent-flow:delivery:run-1:2:blocked:lane.a -->";
  const matchingComment = {
    id: 41,
    html_url: "https://github.com/netfishx/agent-flow/issues/26#issuecomment-41",
    body: `prefix\n${marker}\nsuffix`,
  };

  test.each([
    ["slurped pages", JSON.stringify([[matchingComment], []])],
    ["bare page", JSON.stringify([matchingComment])],
  ])("finds one exact marker in %s", async (_shape, stdout) => {
    const runner = recordingRunner([{ stdout }]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.findCommentByMarker(authorizedTarget, marker),
    ).resolves.toEqual({
      commentId: 41,
      commentUrl:
        "https://github.com/netfishx/agent-flow/issues/26#issuecomment-41",
    });
    expect(runner.calls[0]).toEqual({
      argv: [
        "api",
        "repos/netfishx/agent-flow/issues/26/comments",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
      ],
      stdin: null,
    });
  });

  test("returns null for zero line matches without confusing prose for a marker", async () => {
    const runner = recordingRunner([
      {
        stdout: JSON.stringify([
          {
            id: 42,
            html_url:
              "https://github.com/netfishx/agent-flow/issues/26#issuecomment-42",
            body: "ordinary prose containing a period.",
          },
        ]),
      },
      {
        stdout: JSON.stringify([
          {
            id: 42,
            html_url:
              "https://github.com/netfishx/agent-flow/issues/26#issuecomment-42",
            body: "ordinary prose containing a period.",
          },
        ]),
      },
    ]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.findCommentByMarker(
        authorizedTarget,
        "<!-- agent-flow:delivery:other:1:start -->",
      ),
    ).resolves.toBeNull();
    await expect(
      tracker.findCommentByMarker(authorizedTarget, "."),
    ).resolves.toBeNull();
  });

  test.each([
    ["underscore", underscoreMarker],
    ["dot", dotMarker],
  ])(
    "finds an opaque marker containing a %s when it occupies its own line",
    async (_name, opaqueMarker) => {
      const runner = recordingRunner([
        {
          stdout: JSON.stringify([
            {
              ...matchingComment,
              body: `prefix\n${opaqueMarker}\nsuffix`,
            },
          ]),
        },
      ]);
      const tracker = new RealIssueTracker({
        authorizedTarget,
        run: runner.run,
      });

      await expect(
        tracker.findCommentByMarker(authorizedTarget, opaqueMarker),
      ).resolves.toEqual({
        commentId: matchingComment.id,
        commentUrl: matchingComment.html_url,
      });
    },
  );

  test("does not match a marker that appears only inside prose", async () => {
    const runner = recordingRunner([
      {
        stdout: JSON.stringify([
          {
            ...matchingComment,
            body: `prefix ${marker} suffix`,
          },
        ]),
      },
    ]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.findCommentByMarker(authorizedTarget, marker),
    ).resolves.toBeNull();
  });

  test("matches a marker line with trailing whitespace and carriage return", async () => {
    const runner = recordingRunner([
      {
        stdout: JSON.stringify([
          {
            ...matchingComment,
            body: `prefix\n${underscoreMarker} \t\r\nsuffix`,
          },
        ]),
      },
    ]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.findCommentByMarker(authorizedTarget, underscoreMarker),
    ).resolves.toEqual({
      commentId: matchingComment.id,
      commentUrl: matchingComment.html_url,
    });
  });

  test.each(["", " \t\r\n"])(
    "rejects an empty or whitespace-only marker before running a command",
    async (invalidMarker) => {
      const runner = recordingRunner([]);
      const tracker = new RealIssueTracker({
        authorizedTarget,
        run: runner.run,
      });

      await expect(
        tracker.findCommentByMarker(authorizedTarget, invalidMarker),
      ).rejects.toMatchObject({
        name: "IssueTrackerError",
        retryable: false,
      });
      expect(runner.calls).toHaveLength(0);
    },
  );

  test("rejects duplicate marker matches as non-retryable", async () => {
    const runner = recordingRunner([
      { stdout: JSON.stringify([matchingComment, matchingComment]) },
    ]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.findCommentByMarker(authorizedTarget, marker),
    ).rejects.toMatchObject({
      name: "IssueTrackerError",
      reason: "issue tracker duplicate marker condition",
      retryable: false,
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.argv).toContain("GET");
  });
});

describe("RealIssueTracker comments and label transition", () => {
  test("sends the comment body only on stdin and parses the created comment", async () => {
    const body = "true";
    const runner = recordingRunner([
      {
        stdout: JSON.stringify({
          id: 51,
          html_url:
            "https://github.com/netfishx/agent-flow/issues/26#issuecomment-51",
          body,
        }),
      },
    ]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.createComment(authorizedTarget, body),
    ).resolves.toEqual({
      commentId: 51,
      commentUrl:
        "https://github.com/netfishx/agent-flow/issues/26#issuecomment-51",
    });
    expect(runner.calls).toEqual([
      {
        argv: [
          "api",
          "repos/netfishx/agent-flow/issues/26/comments",
          "--method",
          "POST",
          "--input",
          "-",
        ],
        stdin: JSON.stringify({ body }),
      },
    ]);
    expect(runner.calls[0]?.argv).not.toContain(body);
    const stdin = runner.calls[0]?.stdin;
    expect(stdin).not.toBeNull();
    const payload = JSON.parse(stdin as string) as { body: unknown };
    expect(payload).toEqual({ body });
    expect(typeof payload.body).toBe("string");
  });

  test("parses the current label names", async () => {
    const runner = recordingRunner([
      {
        stdout: JSON.stringify({
          labels: [{ name: "ready-for-agent" }, { name: "bug" }],
        }),
      },
    ]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.readCurrentLabels(authorizedTarget),
    ).resolves.toEqual(["ready-for-agent", "bug"]);
  });

  test("adds the next label before removing the expected label", async () => {
    const runner = recordingRunner([
      {
        stdout: JSON.stringify({
          labels: [{ name: "ready-for-agent" }, { name: "bug" }],
        }),
      },
      { stdout: "[]" },
      { stdout: "" },
    ]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.compareAndSetTriageLabel(
        authorizedTarget,
        "ready-for-agent",
        "needs-info",
      ),
    ).resolves.toBe("applied");
    expect(runner.calls.map(({ argv }) => argv)).toEqual([
      [
        "api",
        "repos/netfishx/agent-flow/issues/26",
        "--method",
        "GET",
      ],
      [
        "api",
        "repos/netfishx/agent-flow/issues/26/labels",
        "--method",
        "POST",
        "--raw-field",
        "labels[]=needs-info",
      ],
      [
        "api",
        "repos/netfishx/agent-flow/issues/26/labels/ready-for-agent",
        "--method",
        "DELETE",
      ],
    ]);
  });

  test("preserves a later human triage state with zero mutating calls", async () => {
    const runner = recordingRunner([
      {
        stdout: JSON.stringify({
          labels: [{ name: "ready-for-human" }],
        }),
      },
    ]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    await expect(
      tracker.compareAndSetTriageLabel(
        authorizedTarget,
        "ready-for-agent",
        "needs-info",
      ),
    ).resolves.toBe("skipped");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.argv).toContain("GET");
  });

  test.each([
    ["arbitrary", "ready-for-agent", "ready-for-human"],
    ["wontfix", "ready-for-agent", "wontfix"],
  ])(
    "rejects the forbidden %s label transition before any command",
    async (_name, expected, next) => {
      const runner = recordingRunner([]);
      const tracker = new RealIssueTracker({
        authorizedTarget,
        run: runner.run,
      });

      await expect(
        tracker.compareAndSetTriageLabel(
          authorizedTarget,
          expected,
          next,
        ),
      ).rejects.toMatchObject({
        name: "IssueTrackerError",
        retryable: false,
      });
      expect(runner.calls).toHaveLength(0);
    },
  );
});

describe("GitHub capability hygiene", () => {
  test("the port exposes exactly five capabilities", () => {
    type Expected =
      | "resolveIssue"
      | "findCommentByMarker"
      | "createComment"
      | "readCurrentLabels"
      | "compareAndSetTriageLabel";
    type Exact =
      [keyof IssueTracker] extends [Expected]
        ? [Expected] extends [keyof IssueTracker]
          ? true
          : false
        : false;
    const exact: Exact = true;
    expect(exact).toBe(true);
  });

  test("the complete builder whitelist cannot widen the mutation surface", () => {
    expect(Object.keys(ghArgvBuilders).sort()).toEqual([
      "addLabel",
      "createComment",
      "listComments",
      "readCurrentLabels",
      "removeLabel",
      "resolveIssue",
    ]);
    const commands = [
      ghArgvBuilders.resolveIssue(authorizedTarget),
      ghArgvBuilders.listComments(authorizedTarget),
      ghArgvBuilders.createComment(authorizedTarget),
      ghArgvBuilders.readCurrentLabels(authorizedTarget),
      ghArgvBuilders.addLabel(authorizedTarget, "ready-for-human"),
      ghArgvBuilders.removeLabel(authorizedTarget, "ready-for-agent"),
    ];
    const requests = commands.map((argv) => {
      const methodFlag = argv.indexOf("--method");
      return {
        path: argv[1],
        method: argv[methodFlag + 1],
        argv,
      };
    });

    expect(
      requests
        .filter(({ method }) => method !== "GET")
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST repos/netfishx/agent-flow/issues/26/comments",
      "POST repos/netfishx/agent-flow/issues/26/labels",
      "DELETE repos/netfishx/agent-flow/issues/26/labels/ready-for-agent",
    ]);
    for (const { path, method, argv } of requests) {
      if (path === "repos/netfishx/agent-flow/issues/26") {
        expect(method).toBe("GET");
      }
      expect(argv.join("\n")).not.toMatch(
        /(?:assignees|state|title|Authorization)/i,
      );
    }
  });

  test("every capability keeps environment credentials and the delivery body out of argv", async () => {
    const ghToken = "ghp_GH_TOKEN_SENTINEL";
    const githubToken = "ghp_GITHUB_TOKEN_SENTINEL";
    const body = "delivery body sentinel";
    const previousGhToken = process.env.GH_TOKEN;
    const previousGithubToken = process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = ghToken;
    process.env.GITHUB_TOKEN = githubToken;
    try {
      const runner = recordingRunner([
        { stdout: '{"node_id":"I_kwDOB7"}' },
        { stdout: "[]" },
        {
          stdout: JSON.stringify({
            id: 61,
            html_url:
              "https://github.com/netfishx/agent-flow/issues/26#issuecomment-61",
          }),
        },
        { stdout: '{"labels":[]}' },
        { stdout: '{"labels":[{"name":"ready-for-agent"}]}' },
        { stdout: "[]" },
        { stdout: "" },
      ]);
      const tracker = new RealIssueTracker({
        authorizedTarget,
        run: runner.run,
      });

      await tracker.resolveIssue(authorizedTarget);
      await tracker.findCommentByMarker(
        authorizedTarget,
        "<!-- agent-flow:delivery:run-26:1:start -->",
      );
      await tracker.createComment(authorizedTarget, body);
      await tracker.readCurrentLabels(authorizedTarget);
      await tracker.compareAndSetTriageLabel(
        authorizedTarget,
        "ready-for-agent",
        "needs-info",
      );

      expect(runner.calls).toHaveLength(7);
      for (const { argv } of runner.calls) {
        expect(argv).not.toContain("-H");
        expect(argv).not.toContain("--header");
        expect(argv.join("\n")).not.toContain(ghToken);
        expect(argv.join("\n")).not.toContain(githubToken);
        expect(argv.join("\n")).not.toContain(body);
      }
      expect(runner.calls[2]?.stdin).toBe(JSON.stringify({ body }));
    } finally {
      if (previousGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
      if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGithubToken;
    }
  });
});

describe("RealIssueTracker failure boundaries", () => {
  test("classifies a rejected command runner as retryable", async () => {
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: async () => {
        throw new Error("spawn ENOENT ghp_SECRET");
      },
    });

    await expect(
      tracker.resolveIssue(authorizedTarget),
    ).rejects.toMatchObject({
      name: "IssueTrackerError",
      reason: "issue tracker resolve issue failed",
      retryable: true,
    });
  });

  test("classifies command stderr without leaking it", async () => {
    const secret = "Authorization: token ghp_SECRET";
    const runner = recordingRunner([
      {
        stdout: "",
        stderr: `${secret} (HTTP 404)`,
        exitCode: 1,
      },
    ]);
    const tracker = new RealIssueTracker({
      authorizedTarget,
      run: runner.run,
    });

    try {
      await tracker.resolveIssue(authorizedTarget);
      throw new Error("expected resolveIssue to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(IssueTrackerError);
      expect((error as IssueTrackerError).retryable).toBe(false);
      expect((error as IssueTrackerError).reason).toBe(
        "issue tracker resolve issue failed (HTTP 404)",
      );
      expect((error as IssueTrackerError).reason).not.toContain(secret);
    }
  });

  test.each([
    [
      "resolve",
      (tracker: RealIssueTracker) =>
        tracker.resolveIssue(authorizedTarget),
      "{bad",
    ],
    [
      "marker lookup",
      (tracker: RealIssueTracker) =>
        tracker.findCommentByMarker(
          authorizedTarget,
          "<!-- agent-flow:delivery:run-26:1:start -->",
        ),
      "{}",
    ],
    [
      "comment creation",
      (tracker: RealIssueTracker) =>
        tracker.createComment(authorizedTarget, "body"),
      "[]",
    ],
    [
      "label read",
      (tracker: RealIssueTracker) =>
        tracker.readCurrentLabels(authorizedTarget),
      '{"labels":[{}]}',
    ],
  ] as const)(
    "treats malformed %s response as non-retryable",
    async (_name, operation, stdout) => {
      const runner = recordingRunner([{ stdout }]);
      const tracker = new RealIssueTracker({
        authorizedTarget,
        run: runner.run,
      });

      await expect(operation(tracker)).rejects.toMatchObject({
        name: "IssueTrackerError",
        retryable: false,
      });
    },
  );
});
