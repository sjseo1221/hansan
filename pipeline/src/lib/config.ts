import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface SeoulCitydataConfig {
  baseUrl: string;
  service: string;
  dailyCap: number;
  timeoutMs: number;
  concurrency: number;
}

export interface SourcesConfig {
  seoul_citydata: SeoulCitydataConfig;
}

export async function loadSources(path = "config/sources.yaml"): Promise<SourcesConfig> {
  return parse(await readFile(path, "utf8")) as SourcesConfig;
}
