import { describe, expect, test } from "bun:test";
import { runCli } from "../helpers";

// Contract tests replay the smoke flow (search -> read first doc_id ->
// feedback) against a real deployment. Gated so unit runs stay hermetic:
//   CAESAR_CONTRACT=1 CAESAR_BASE_URL=... [CAESAR_API_KEY=...] bun test test/contract
const enabled = process.env.CAESAR_CONTRACT === "1";
const baseUrl = process.env.CAESAR_BASE_URL ?? "";
const apiKey = process.env.CAESAR_API_KEY ?? "";

describe.if(enabled)("contract: search -> read -> feedback", () => {
  const env = { CAESAR_BASE_URL: baseUrl, CAESAR_API_KEY: apiKey };

  test("full flow", async () => {
    const search = await runCli(["search", "agent search api", "--max-results", "3", "--json"], { env });
    expect(search.code).toBe(0);
    const searchPayload = JSON.parse(search.stdout);
    expect(searchPayload.results.length).toBeGreaterThan(0);
    const docID = searchPayload.results[0].doc_id;
    const searchID = searchPayload.search_id;
    expect(docID).toBeTruthy();

    const read = await runCli(["read", docID, "--max-chars", "2000", "--json"], { env });
    expect(read.code).toBe(0);
    const readPayload = JSON.parse(read.stdout);
    expect(readPayload.doc.doc_id).toBe(docID);

    const feedback = await runCli(
      [
        "feedback",
        "--event-type",
        "result_helpful",
        "--search-id",
        searchID,
        "--doc-id",
        docID,
        "--query",
        "agent search api",
        "--json",
      ],
      { env },
    );
    expect(feedback.code).toBe(0);
    expect(JSON.parse(feedback.stdout).accepted).toBe(true);
  }, 120_000);
});
