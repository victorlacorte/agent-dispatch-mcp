import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { DispatchError, type JobService } from "./jobs.ts";
import { HARNESSES, JOB_STATES, SANDBOXES } from "./types.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Harness identifiers: no leading dash, so they cannot be read as command-line flags. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_WAIT_JOBS = 50;

/** Compact JSON keeps the orchestrator's token cost down. */
function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Expected failures become short tool errors; anything else is a bug and propagates. */
async function guarded(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    if (error instanceof DispatchError) return toolError(error.message);
    throw error;
  }
}

export function createServer(jobs: JobService, version: string): McpServer {
  const server = new McpServer({ name: "agent-dispatch", version });
  const maxWait = jobs.config.maxWaitSeconds;

  // Inside a dispatched worker, starting or stopping jobs is refused, so those tools are not
  // advertised at all (they would only cost the worker context).
  if (!jobs.insideWorker) {
    server.registerTool(
      "dispatch",
      {
        description:
          "Start a worker agent in another harness. Returns a job_id at once; get the result with `wait`. " +
          "The prompt must be self-contained: the worker sees nothing of this conversation.",
        inputSchema: {
          harness: z.enum(HARNESSES),
          model: z.string().regex(IDENTIFIER).describe("e.g. gpt-6-luna"),
          effort: z.string().regex(IDENTIFIER).describe("e.g. low, medium, high, max"),
          sandbox: z
            .enum(SANDBOXES)
            .describe("workspace-write only inside a worktree dedicated to this job"),
          cwd: z.string().min(1).describe("Absolute path"),
          prompt: z.string().min(1),
          label: z.string().min(1).max(80).describe("Short kebab-case task label"),
          timeout_s: z.number().int().positive().max(86_400).default(1800),
        },
      },
      async (args) =>
        guarded(async () => {
          const meta = await jobs.dispatch(
            {
              harness: args.harness,
              model: args.model,
              effort: args.effort,
              sandbox: args.sandbox,
              cwd: args.cwd,
              label: args.label,
              timeoutSeconds: args.timeout_s,
            },
            args.prompt,
          );
          return { job_id: meta.jobId, state: meta.state };
        }),
    );

    server.registerTool(
      "cancel",
      {
        description: "Stop a job and its process tree; returns once termination is confirmed.",
        inputSchema: { job_id: z.string() },
      },
      async (args) => guarded(() => jobs.cancel(args.job_id)),
    );
  }

  server.registerTool(
    "wait",
    {
      description:
        `Block until jobs finish (mode all: every job, any: at least one) or timeout_s passes (default and max ${maxWait}). ` +
        "Returns finished jobs (final_message, usage, failure_reason; full logs in dir) and pending ones. " +
        "To keep waiting, call again with only the pending job_ids.",
      inputSchema: {
        job_ids: z.array(z.string()).min(1).max(MAX_WAIT_JOBS),
        mode: z.enum(["any", "all"]).default("all"),
        timeout_s: z.number().int().min(0).max(maxWait).default(maxWait),
      },
    },
    async (args) => guarded(() => jobs.wait(args.job_ids, args.timeout_s, args.mode)),
  );

  server.registerTool(
    "list",
    {
      description: "Recent jobs, newest first; e.g. to recover job_ids after a session restart.",
      inputSchema: {
        state: z.enum(JOB_STATES).optional(),
        limit: z.number().int().positive().max(200).default(20),
      },
    },
    async (args) => guarded(() => jobs.list(args.state, args.limit)),
  );

  return server;
}
