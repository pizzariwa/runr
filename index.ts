#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { execa } from "execa";
import { intro, outro, log, select, spinner, group, text, cancel, confirm } from "@clack/prompts";
import type {
  WorkflowDispatchInput,
  WorkflowDispatchParsed,
} from "./workflow_types.js";
import { isChoiceInput } from "./workflow_types.js";

// EXECA DOCS : https://github.com/sindresorhus/execa/blob/main/docs/execution.md

const CONFIG_PATH = "./config.yml";

// Define the expected structure of your config
export interface Bookmark {
  nickname: string;
  workflow: string;
  branch: string;
  inputs: Record<string, string>;
}

export interface RepoConfig {
  repos: Array<{
    name: string;
    branches: string[];
    bookmarks?: Bookmark[];
  }>;
}

interface Workflow {
  name: string;
  path: string;
  id: number;
  state: string;
}

export interface WorkflowInput {
  name: string;
  type: string;
  default: string;
  options: string[] | undefined;
  required: boolean;
}

// Exported functions for testing
export async function checkLogin(): Promise<boolean> {
  try {
    await execa`gh auth status`;
    return true;
  } catch (e) {
    return false;
  }
}

export async function loadConfig(configPath: string = "./config.yml"): Promise<RepoConfig> {
  const configText = await readFile(configPath, "utf8");
  return parseYaml(configText) as RepoConfig;
}

export function getRepoList(config: RepoConfig): string[] {
  return config.repos.map((repo) => repo.name).sort();
}

export function getBranchesForRepo(config: RepoConfig, repoName: string): string[] {
  const repo = config.repos.find((r) => r.name === repoName);
  return repo?.branches || [];
}

export async function listWorkflows(repo: string): Promise<Workflow[]> {
  const workflowResult = await execa`gh workflow list -R ${repo} --json name,path,id,state`;
  return JSON.parse(workflowResult.stdout);
}

export function filterActiveWorkflows(workflows: Workflow[]): Workflow[] {
  return workflows.filter((w) => w.state === "active").sort();
}

export async function getWorkflowInputs(
  workflowName: string,
  repo: string,
  branch: string
): Promise<WorkflowInput[]> {
  const workflowViewCommandOutput =
    await execa`gh workflow view ${workflowName} -R ${repo} --ref ${branch} --yaml`;

  const workflow = parseYaml(workflowViewCommandOutput.stdout) as WorkflowDispatchParsed;
  const inputs: Record<string, WorkflowDispatchInput> | undefined = workflow.on.workflow_dispatch.inputs;

  return Object.entries(inputs ?? {}).map(([name, input]) => ({
    name,
    type: input.type,
    default: String(input.default ?? ""),
    options: isChoiceInput(input) ? input.options : undefined,
    required: input.required,
  }));
}

export function buildInputPrompts(
  inputs: WorkflowInput[]
): Record<string, () => ReturnType<typeof text> | ReturnType<typeof select>> {
  const createdGroup: Record<string, () => ReturnType<typeof text> | ReturnType<typeof select>> = {};

  inputs.forEach((input) => {
    switch (input.type) {
      case "string":
      case "number":
      case "environment":
        createdGroup[input.name] = () => text({
          message: "Input " + input.name,
          placeholder: "Required? " + input.required,
          initialValue: input.default
        });
        break;
      case "boolean":
        createdGroup[input.name] = () => select({
          message: "Input " + input.name,
          options: [{ value: "true", label: "True" }, { value: "false", label: "False" }],
          initialValue: input.default
        });
        break;
      case "choice":
        createdGroup[input.name] = () => select({
          message: "Input " + input.name,
          options: (input.options ?? []).map((opt) => ({ value: opt, label: opt })),
          initialValue: input.default
        });
        break;
      default:
        log.error("Invalid Input Type !")
    }
  });

  return createdGroup;
}

export function buildWorkflowRunArgs(
  workflowName: string,
  repo: string,
  branch: string,
  inputGroup: Record<string, unknown>
): string[] {
  const workflowRunArgs: string[] = [
    "workflow", "run", workflowName,
    "-R", repo,
    "--ref", branch,
  ];

  for (const [key, value] of Object.entries(inputGroup)) {
    workflowRunArgs.push("-f", `${key}=${value}`);
  }

  return workflowRunArgs;
}

export function buildDisplayInfo(
  workflowName: string,
  repo: string,
  branch: string,
  inputGroup: Record<string, unknown>
): string {
  return [
    `Running Workflow : ${workflowName}`,
    `Repo             : ${repo}`,
    `Branch           : ${branch}`,
    ``,
    `Inputs :`,
    ...Object.entries(inputGroup).map(([k, v]) => `  ${k.padEnd(15)} : ${v}`)
  ].join("\n");
}

export function getBookmarksForRepo(config: RepoConfig, repoName: string): Bookmark[] {
  const repo = config.repos.find((r) => r.name === repoName);
  return repo?.bookmarks || [];
}

export async function saveBookmark(
  configPath: string,
  repoName: string,
  bookmark: Bookmark
): Promise<void> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { stringify: stringifyYaml } = await import("yaml");
  
  const configText = await readFile(configPath, "utf8");
  const config = parseYaml(configText) as RepoConfig;
  
  const repo = config.repos.find((r) => r.name === repoName);
  if (!repo) {
    throw new Error(`Repository ${repoName} not found in config`);
  }
  
  if (!repo.bookmarks) {
    repo.bookmarks = [];
  }
  
  repo.bookmarks.push(bookmark);
  
  await writeFile(configPath, stringifyYaml(config), "utf8");
}

// Main function that orchestrates the workflow
export async function runWorkflowCreation(): Promise<void> {
  intro("Starting Workflow Creation");

  const s = spinner();

  s.start("Checking Login");
  // --- LOGIN STATE
  const isLoggedIn = await checkLogin();
  if (isLoggedIn) {
    log.success("Logged in to GitHub");
  } else {
    log.error("You are not logged in! Run `gh auth login` to authenticate with GitHub");
    s.stop();
    process.exit(1);
  }
  s.stop();
  outro("Finished Checking Login");

  intro("Loading Config");

  // Read and parse the YAML config at runtime
  const config = await loadConfig(CONFIG_PATH);
  log.step(`Config : ${JSON.stringify(config, null, 4)}`);
  outro("Finished Loading Config");

  intro("Repo Selection");

  // --- Get All Repos
  const repos = getRepoList(config);
  log.step(`Repos : ${repos}`);

  // --- Pick a Repo
  const repo = await select({
    message: "Pick a repository:",
    options: repos.map((repo) => ({ value: repo })).sort(),
  });

  outro("Finished Repo Selection");

  intro("Branch Selection");

  // -- Get branches for selected repo
  const branch = await select({
    message: "Pick a branch",
    options: getBranchesForRepo(config, String(repo)).map((branch) => ({ value: branch })),
  });

  outro("Finished Branch Selection");

  intro("Workflow Selection");

  const workflows = await listWorkflows(String(repo));
  const activeWorkflows = filterActiveWorkflows(workflows);
  const bookmarks = getBookmarksForRepo(config, String(repo));

  // Build options with bookmarks first, then workflows
  const workflowOptions = [];
  
  // Add bookmarks with ⭐ prefix
  if (bookmarks.length > 0) {
    workflowOptions.push(
      ...bookmarks.map((bookmark, idx) => ({
        value: `bookmark:${idx}`,
        label: `⭐ ${bookmark.nickname}`,
        hint: `${bookmark.workflow} (${bookmark.branch})`,
      }))
    );
  }
  
  // Add regular workflows
  workflowOptions.push(
    ...activeWorkflows.map((w) => ({
      value: `workflow:${w.id}`,
      label: w.name,
      hint: w.path,
    }))
  );

  // Select a workflow or bookmark
  const selection = await select({
    message: "Select Workflow or Bookmark",
    options: workflowOptions,
  });

  const selectionStr = String(selection);
  let selectedWorkflowName: string;
  let inputGroup: Record<string, unknown>;
  let actualBranch: string;

  if (selectionStr.startsWith("bookmark:")) {
    // Handle bookmark selection
    const bookmarkIndexStr = selectionStr.split(":")[1];
    if (!bookmarkIndexStr) {
      log.error("Invalid bookmark selection format");
      process.exit(1);
    }
    const bookmarkIndex = parseInt(bookmarkIndexStr);
    if (isNaN(bookmarkIndex)) {
      log.error("Invalid bookmark index");
      process.exit(1);
    }
    const bookmark = bookmarks[bookmarkIndex];
    
    if (!bookmark) {
      log.error("Invalid bookmark selection");
      process.exit(1);
    }
    
    selectedWorkflowName = bookmark.workflow;
    actualBranch = bookmark.branch;
    inputGroup = bookmark.inputs;
    
    log.step(`Selected Bookmark: [${bookmark.nickname}]`);
    log.step(`Workflow: [${selectedWorkflowName}] on branch [${actualBranch}]`);
    outro("Finished Workflow Selection");
  } else {
    // Handle regular workflow selection
    const workflowIdStr = selectionStr.split(":")[1];
    if (!workflowIdStr) {
      log.error("Invalid workflow selection format");
      process.exit(1);
    }
    const workflowId = parseInt(workflowIdStr);
    if (isNaN(workflowId)) {
      log.error("Invalid workflow ID");
      process.exit(1);
    }
    const selectedWorkflow = activeWorkflows.find((w) => w.id === workflowId);
    
    if (!selectedWorkflow) {
      log.error("Invalid workflow selection");
      process.exit(1);
    }
    
    selectedWorkflowName = selectedWorkflow.name;
    actualBranch = String(branch);

    log.step(`Selected Workflow: [${selectedWorkflowName}]`);
    outro("Finished Workflow Selection");

    intro("Workflow Input Retrieval");

    const inputsArray = await getWorkflowInputs(selectedWorkflowName, String(repo), actualBranch);
    outro("Finished Workflow Input Retrieval");

    intro("User Input Collection");

    const createdGroup = buildInputPrompts(inputsArray);

    inputGroup = await group(
      createdGroup,
      {
        onCancel: ({ results }) => {
          cancel('Operation cancelled.');
          process.exit(0);
        },
      }
    );

    outro("Finished User Input Collection");
    
    // Ask if user wants to save as bookmark
    const shouldSaveBookmark = await confirm({
      message: "Do you want to save this workflow configuration as a bookmark?",
      initialValue: false,
    });
    
    if (shouldSaveBookmark) {
      const nickname = await text({
        message: "Enter a nickname for this bookmark:",
        placeholder: "e.g., Production Deploy",
        validate: (value) => {
          if (!value || value.trim().length === 0) {
            return "Nickname cannot be empty";
          }
        },
      });
      
      if (typeof nickname === "string" && nickname.trim().length > 0) {
        const bookmarkToSave: Bookmark = {
          nickname: nickname.trim(),
          workflow: selectedWorkflowName,
          branch: actualBranch,
          inputs: Object.fromEntries(
            Object.entries(inputGroup).map(([k, v]) => [k, String(v)])
          ),
        };
        
        try {
          await saveBookmark(CONFIG_PATH, String(repo), bookmarkToSave);
          log.success(`Bookmark "${nickname}" saved successfully!`);
        } catch (error) {
          log.error(`Failed to save bookmark: ${error}`);
        }
      }
    }
  }

  intro("Running Workflow");

  const workflowRunArgs = buildWorkflowRunArgs(
    selectedWorkflowName,
    String(repo),
    actualBranch,
    inputGroup
  );

  const displayInfo = buildDisplayInfo(
    selectedWorkflowName,
    String(repo),
    actualBranch,
    inputGroup
  );

  const shouldContinue = await confirm({
    message: `${displayInfo}\n\nDo you want to continue?`,
  });

  s.start("Running Workflow");
  if (shouldContinue) {
    const { stdout } = await execa("gh", workflowRunArgs);
    log.step(`Done ! Result : ${stdout}`);
  }
  s.stop();

  const shouldOpen = await confirm({
    message: "Do you want to open the workflow in the web ui?",
  });

  if (shouldOpen) {
    await execa`gh workflow view ${selectedWorkflowName} -R ${String(repo)} --web`;
  }

  outro(`Done ! \n View your workflow in the web ui : https://github.com/${String(repo)}/actions`);
}

// Only run if this is the main module (not imported for testing)
// In ESM, we check if import.meta.url matches the resolved file path
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runWorkflowCreation().catch((error) => {
    log.error(String(error));
    process.exit(1);
  });
}
