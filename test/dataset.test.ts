import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dataset } from "../src/dataset.js";
import { isCovered } from "../src/dataset.js";
import type { RawWay } from "../src/types.js";

const GERMANY: [number, number, number, number] = [47.2, 5.8, 55.1, 15.1];

function dataset(ways: RawWay[]): Dataset {
  return { generated: null, osmBase: null, bbox: GERMANY, ways };
}

function datasetResponse(): Response {
  return new Response(
    JSON.stringify({ generated: "2026-01-01", bbox: GERMANY, ways: [] }),
    { status: 200 },
  );
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The viewport filter now runs on assembled groups, not on ways: see
// groupsInBounds in test/boardwalks.test.ts.

describe("isCovered", () => {
  const data = dataset([]);

  it("accepts points inside the region", () => {
    expect(isCovered(data, { lat: 53, lon: 8 })).toBe(true);
    expect(isCovered(data, { lat: 47.9, lon: 9.9 })).toBe(true);
  });

  it("rejects points outside it", () => {
    expect(isCovered(data, { lat: 40.4, lon: -3.7 })).toBe(false); // Madrid
    expect(isCovered(data, { lat: 59.3, lon: 18.1 })).toBe(false); // Stockholm
  });
});

describe("loadDataset", () => {
  it("shares one pending load between concurrent callers", async () => {
    let respond: (response: Response) => void = () => {};
    const fetchMock = vi.fn(() => {
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loadDataset } = await import("../src/dataset.js");
    const first = loadDataset();
    const second = loadDataset();

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    respond(datasetResponse());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
  });

  it("caches a successful load", async () => {
    const fetchMock = vi.fn().mockResolvedValue(datasetResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { loadDataset } = await import("../src/dataset.js");
    const first = await loadDataset();
    const second = await loadDataset();

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed load", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Network error"))
      .mockResolvedValueOnce(datasetResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { loadDataset } = await import("../src/dataset.js");

    await expect(loadDataset()).rejects.toMatchObject({
      name: "SearchError",
      retryable: true,
    });
    await expect(loadDataset()).resolves.toMatchObject({ ways: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
