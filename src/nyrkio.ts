/* eslint @typescript-eslint/naming-convention: 0 */
/* eslint @typescript-eslint/no-non-null-assertion: 0 */
/* eslint no-useless-escape: 0 */

import { Benchmark, BenchmarkResult, Commit } from './extract';
import { Config } from './config';
import * as core from '@actions/core';
import axios from 'axios';

export interface NyrkioMetrics {
    name: string;
    unit: string;
    value: number;
    direction?: string;
}

export interface NyrkioJson {
    timestamp: number;
    metrics: NyrkioMetrics[];
    attributes: {
        git_commit: string;
        git_repo: string;
        branch: string;
    };
    extra_info?: object;
}

export interface NyrkioJsonPath {
    path: string;
    git_commit: string;
    results: NyrkioJson[];
}

export interface NyrkioChangePoint {
    metric: string;
    index: number;
    time: number;
    forward_change_percent: string;
    magnitude: string;
    mean_before: string;
    stddev_before: string;
    mean_after: string;
    stddev_after: string;
    pvalue: string;
}

export interface NyrkioChanges {
    time: number;
    attributes: {
        git_commit: string;
        git_repo: string;
        branch: string;
        commit_msg: string;
        test_name: string;
        concurrency: number;
    };
    changes: NyrkioChangePoint[];
}

export interface NyrkioAllChanges {
    path: string;
    changes: NyrkioChanges[];
}

export function sanitizeForUri(value: string | undefined): string {
    const v: string = value ?? '';
    const re = /[^a-zA-Z0-9-_.\/]/gi;
    return v.replace(re, '_');
}

export function nyrkioJsonMetricsInit(b: BenchmarkResult): NyrkioMetrics {
    const NYRKIO_JSON_TEMPLATE_METRICS = { name: b.name, unit: b.unit, value: b.value };
    return NYRKIO_JSON_TEMPLATE_METRICS;
}

export function nyrkioJsonInit(commit: Commit, buildTime: number): NyrkioJson {
    let t = buildTime;
    if (commit.timestamp !== undefined) {
        t = convertDateStringToUnixTimestamp(commit.timestamp);
    } else {
        core.warning('No timestamp found in commit. Using build time = when the benchmark was run.');
    }
    const NYRKIO_JSON_TEMPLATE = {
        timestamp: t,
        metrics: [],
        attributes: {
            git_repo: commit.url.split(/commit/)[0],
            branch: commit.branch ? commit.branch : 'unknown',
            git_commit: commit.id,
        },
        extra_info: { build_time: buildTime },
    };
    return NYRKIO_JSON_TEMPLATE;
}

// function convertDateToUnixTimestamp(d: Date) {
//     return d.getTime() / 1000;
// }

function convertDateStringToUnixTimestamp(d: string) {
    return Date.parse(d) / 1000;
}

class NyrkioResultSorter {
    r: Map<string, Map<string, Map<string, NyrkioJson>>>;

    constructor() {
        this.r = new Map<string, Map<string, Map<string, NyrkioJson>>>();
    }

    add(path: string, git_commit: string, result: NyrkioJson) {
        if (this.r.get(path) === undefined) this.r.set(path, new Map<string, Map<string, NyrkioJson>>());
        if (this.r.get(path)!.get(git_commit) === undefined)
            this.r.get(path)!.set(git_commit, new Map<string, NyrkioJson>());
        if (this.r.get(path)!.get(git_commit)!.get(result.timestamp.toString()) === undefined)
            this.r.get(path)!.get(git_commit)!.set(result.timestamp.toString(), result);
        else this.r.get(path)!.get(git_commit)!.get(result.timestamp.toString())!.metrics.concat(result.metrics);
        core.debug(path);
        core.debug(git_commit);
        core.debug(result.timestamp.toString());
    }

    iterator(): [NyrkioJsonPath] | null {
        core.debug(this.r.toString());
        let ret: [NyrkioJsonPath] | null = null;

        for (let k of this.r.keys()) {
            core.debug(k);
            for (let g of this.r.get(k)!.keys()) {
                core.debug(g);
                for (let t of this.r.get(k)!.get(g)!.keys()) {
                    core.debug(t);
                    if (!ret) {
                        ret = [{ path: k, git_commit: g, results: [this.r.get(k)!.get(g)!.get(t)!] }];
                    } else {
                        ret.push({ path: k, git_commit: g, results: [this.r.get(k)!.get(g)!.get(t)!] });
                    }
                    core.debug(this.r.get(k)!.get(g)!.get(t)!.toString());
                    core.debug(`${ret.length}`);
                }
            }
        }
        return ret;
    }
}

function convertBenchmarkToNyrkioJson(bench: Benchmark, config: Config): [NyrkioJsonPath] | null {
    let { name } = config;

    const benches = bench.benches;
    const d = bench.date / 1000; // Only Unix timestamps in Nyrkiö context.
    let nyrkioResult = nyrkioJsonInit(bench.commit, d);
    let testName: string | undefined = '';
    let branch: string | undefined = undefined;
    name = sanitizeForUri(name);
    let nyrkioPath = name;
    const nsrt = new NyrkioResultSorter();
    for (const b of benches) {
        if (testName !== b.testName) {
            if (nyrkioResult.metrics.length > 0) {
                nsrt.add(nyrkioPath, bench.commit.id, nyrkioResult);
            }

            nyrkioResult = nyrkioJsonInit(bench.commit, d);
            testName = sanitizeForUri(b.testName);
            branch = sanitizeForUri(nyrkioResult.attributes.branch);
            core.debug(branch);
            if (testName && testName.length > 0) {
                nyrkioPath = name + '/' + branch + '/' + testName;
            } else {
                nyrkioPath = name;
            }
        }
        const m = nyrkioJsonMetricsInit(b);
        m.value = b.value;
        m.name = b.name;
        m.unit = b.unit;
        nyrkioResult.metrics.push(m);
    }
    if (nyrkioResult.metrics.length > 0) {
        nsrt.add(nyrkioPath, bench.commit.id, nyrkioResult);
    }
    return nsrt.iterator();
}

async function setParameters(config: Config) {
    const { nyrkioPvalue, nyrkioThreshold } = config;
    if (nyrkioPvalue === null && nyrkioThreshold === null) return;

    const { nyrkioToken, nyrkioApiRoot } = config;
    const options = {
        headers: {
            Authorization: 'Bearer ' + (nyrkioToken ? nyrkioToken : ''),
        },
    };
    const configObject = {
        core: { min_magnitude: nyrkioThreshold, max_pvalue: nyrkioPvalue },
    };
    const uri = nyrkioApiRoot + 'user/config';
    core.debug('POST Nyrkiö config: ' + uri);
    // Will throw on failure
    const response = await axios.post(uri, configObject, options);
    core.debug(response.toString());
}

async function postResults(
    allTestResults: [NyrkioJsonPath],
    config: Config,
    commit: Commit,
): Promise<[NyrkioAllChanges] | boolean> {
    await setParameters(config);
    const { nyrkioToken, nyrkioApiRoot, nyrkioOrg, neverFail } = config;
    core.debug(nyrkioToken ? nyrkioToken.substring(0, 5) : "WHERE's MY TOKEN???");
    const options = {
        headers: {
            Authorization: `Bearer ${nyrkioToken}`,
        },
    };
    let allChanges: [NyrkioAllChanges] | boolean = false;

    for (const r of allTestResults) {
        core.debug(r.path);
        let uri = `${nyrkioApiRoot}result/${r.path}`;
        if (commit.prNumber) {
            uri = `${nyrkioApiRoot}pulls/${commit.repo}/${commit.prNumber}/result/${nyrkioOrg}/${r.path}`;
        }
        if (nyrkioOrg !== undefined) {
            uri = `${nyrkioApiRoot}orgs/result/${nyrkioOrg}/${r.path}`;
            if (commit.prNumber) {
                uri = `${nyrkioApiRoot}orgs/pulls/${commit.repo}/${commit.prNumber}/result/${nyrkioOrg}/${r.path}`;
            }
        }
        console.log('PUT results: ' + uri);
        try {
            // Will throw on failure
            const response = await axios.put(uri, r.results, options);
            if (response.data) {
                const resp = response.data;
                const v = resp[r.path];
                const c: [NyrkioChanges] | [] = <[NyrkioChanges] | []>v;
                if (c === undefined || c.length === 0) continue;

                // Note: In extreme cases Nyrkiö might alert immediately after you committed a regression.
                // However, in most cases you'll get a separate alert a few days later, once the statistical
                // significance accumulates.
                for (const changePoint of c) {
                    if (changePoint.attributes.git_commit === r.git_commit) {
                        const cc: NyrkioAllChanges = { path: r.path, changes: c };
                        if (allChanges === false) allChanges = [cc];
                        else allChanges.push(cc);
                    }
                }
            }
        } catch (err: any) {
            console.error(`PUT to ${uri} failed. I'll keep trying with the others though.`);
            if (err & err.toJSON) {
                console.error(err.toJSON());
            } else {
                console.error(err);
            }
            if (!neverFail) {
                core.setFailed(`PUT to ${uri} failed. ${err.status} ${err.code}.`);
            } else {
                console.error(
                    'Note: never-fail is true. Ignoring this error and continuing. Will exit successfully to keep the build green.',
                );
            }
        }
    }
    return allChanges;
}

export async function nyrkioFindChanges(b: Benchmark, config: Config) {
    const { nyrkioEnable, failOnAlert, neverFail } = config;
    core.debug('nyrkio-enable=' + nyrkioEnable.toString());
    if (!nyrkioEnable) return;

    const allTestResults = convertBenchmarkToNyrkioJson(b, config);
    core.debug(JSON.stringify(allTestResults));
    if (allTestResults === null) return;

    const changes = await postResults(allTestResults, config, b.commit);
    if (changes && failOnAlert) {
        console.error("\n\nNyrkiö detected a change in your performance test results. Please see the log for details.\n");
        console.error(JSON.stringify(changes, null, 4));
        if (!neverFail) {
            core.setFailed(
                'Nyrkiö detected a change in your performance test results. Please see the log for details.',
            );
        } else {
            console.error(
                'Note: never-fail is true. Ignoring this error and continuing. Will exit successfully to keep the build green.',
            );
        }
    } else {
        console.log(
            "Nyrkiö didn't find any changes now. But you should check again in a week or so, smaller changes are detected with a delay to avoid false positives.",
        );
    }
    console.log('https://nyrkiö.com');
    return;
}
