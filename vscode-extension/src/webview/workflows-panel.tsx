import { useMemo, useState } from "react";
import type { Skill } from "./chat-controls";
import {
  COMPUTE_INSTANCES,
  LOCAL_INSTANCE,
  MODELS,
} from "./chat-controls";
import workflowsData from "./data/workflows.json";

export type Workflow = {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  prompt: string;
  suggestedSkills: string[];
  placeholders: { key: string; label: string; required: boolean }[];
  requiresFiles: boolean;
};

export const WORKFLOWS = workflowsData as Workflow[];

const CATEGORIES: { id: string; label: string }[] = [
  { id: "paper", label: "Paper & Manuscript" },
  { id: "visual", label: "Visual & Presentation" },
  { id: "data", label: "Data & Analysis" },
  { id: "literature", label: "Literature & Research" },
  { id: "grants", label: "Grants & Planning" },
  { id: "scicomm", label: "Science Communication" },
  { id: "genomics", label: "Genomics & Transcriptomics" },
  { id: "proteomics", label: "Proteomics & Structural Biology" },
  { id: "cellbio", label: "Cell Biology & Single-Cell" },
  { id: "chemistry", label: "Chemistry & Computational Chemistry" },
  { id: "drugdiscovery", label: "Drug Discovery & Pharmacology" },
  { id: "physics", label: "Physics & Quantum Computing" },
  { id: "materials", label: "Materials Science" },
  { id: "clinical", label: "Clinical & Health Sciences" },
  { id: "neuro", label: "Neuroscience" },
  { id: "ecology", label: "Ecology & Environmental Science" },
  { id: "finance", label: "Finance & Economics" },
  { id: "social", label: "Social Sciences" },
  { id: "math", label: "Mathematics & Modeling" },
  { id: "ml", label: "Machine Learning & AI" },
  { id: "engineering", label: "Engineering & Simulation" },
  { id: "astro", label: "Astronomy & Space Science" },
];

export function assembleWorkflowPrompt(
  workflow: Workflow,
  placeholderValues: Record<string, string>,
  editedPrompt?: string | null,
) {
  if (editedPrompt && editedPrompt.trim().length > 0) {
    return editedPrompt.trim();
  }

  let prompt = workflow.prompt;
  for (const placeholder of workflow.placeholders) {
    const value = placeholderValues[placeholder.key]?.trim() || `[${placeholder.label}]`;
    prompt = prompt.replaceAll(`{${placeholder.key}}`, value);
  }
  return prompt;
}

function getCategoryLabel(categoryId: string) {
  return CATEGORIES.find((category) => category.id === categoryId)?.label ?? categoryId;
}

function getWorkflowGlyph(icon: string) {
  return icon.slice(0, 1).toUpperCase() || "W";
}

function resolveSuggestedSkillIds(workflow: Workflow, availableSkills: Skill[]) {
  return availableSkills
    .filter((skill) => workflow.suggestedSkills.includes(skill.id))
    .map((skill) => skill.id);
}

export type WorkflowLaunchRequest = {
  prompt: string;
  modelId: string;
  computeId: string;
  suggestedSkillIds: string[];
};

export function WorkflowsPanel({
  availableSkills,
  currentComputeId,
  currentModelId,
  launchDisabled,
  launchDisabledReason,
  modalConfigured,
  onLaunch,
}: {
  availableSkills: Skill[];
  currentComputeId: string;
  currentModelId: string;
  launchDisabled: boolean;
  launchDisabledReason?: string;
  modalConfigured: boolean;
  onLaunch: (request: WorkflowLaunchRequest) => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(WORKFLOWS[0]?.id ?? null);
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>({});
  const [editedPrompt, setEditedPrompt] = useState<string | null>(null);
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [workflowModelId, setWorkflowModelId] = useState(currentModelId);
  const [workflowComputeId, setWorkflowComputeId] = useState(currentComputeId);

  const filteredWorkflows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return WORKFLOWS;
    }

    return WORKFLOWS.filter((workflow) =>
      workflow.name.toLowerCase().includes(query) ||
      workflow.description.toLowerCase().includes(query) ||
      workflow.category.toLowerCase().includes(query) ||
      workflow.suggestedSkills.some((skill) => skill.toLowerCase().includes(query)),
    );
  }, [search]);

  const selectedWorkflow = useMemo(
    () => filteredWorkflows.find((workflow) => workflow.id === selectedWorkflowId) ?? filteredWorkflows[0] ?? null,
    [filteredWorkflows, selectedWorkflowId],
  );

  const groupedCategories = useMemo(
    () => CATEGORIES.map((category) => ({
      ...category,
      workflows: filteredWorkflows.filter((workflow) => workflow.category === category.id),
    })).filter((category) => category.workflows.length > 0),
    [filteredWorkflows],
  );

  const assembledPrompt = selectedWorkflow
    ? assembleWorkflowPrompt(selectedWorkflow, placeholderValues, editedPrompt)
    : "";
  const finalPrompt = editedPrompt ?? assembledPrompt;
  const canLaunch = Boolean(
    selectedWorkflow &&
      selectedWorkflow.placeholders.filter((placeholder) => placeholder.required).every((placeholder) =>
        placeholderValues[placeholder.key]?.trim(),
      ) &&
      !launchDisabled,
  );

  return (
    <section aria-label="Workflows panel" className="workflows-panel">
      <div className="workflows-toolbar">
        <label className="workflows-search">
          <span className="workflows-search__label">Search</span>
          <input
            className="workflows-search__input"
            data-workflows-search
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search workflows"
            type="search"
            value={search}
          />
        </label>
        <div className="workflows-categories" role="list">
          {groupedCategories.map((category) => (
            <button
              className="workflows-category-chip"
              data-workflows-category={category.id}
              key={category.id}
              onClick={() => setSelectedWorkflowId(category.workflows[0]?.id ?? null)}
              type="button"
            >
              {category.label}
            </button>
          ))}
        </div>
      </div>

      <div className="workflows-layout">
        <div className="workflows-list" role="list">
          {groupedCategories.map((category) => (
            <section className="workflow-group" data-workflows-group={category.id} key={category.id}>
              <h3 className="workflow-group__title">{category.label}</h3>
              <div className="workflow-group__items">
                {category.workflows.map((workflow) => {
                  const selected = workflow.id === selectedWorkflow?.id;
                  return (
                    <button
                      className={`workflow-card${selected ? " workflow-card--selected" : ""}`}
                      data-workflow-id={workflow.id}
                      key={workflow.id}
                        onClick={() => {
                          setSelectedWorkflowId(workflow.id);
                          setPlaceholderValues({});
                          setEditedPrompt(null);
                          setIsEditingPrompt(false);
                          setWorkflowModelId(currentModelId);
                          setWorkflowComputeId(currentComputeId);
                        }}
                      type="button"
                    >
                      <span className="workflow-card__glyph" aria-hidden="true">{getWorkflowGlyph(workflow.icon)}</span>
                      <span className="workflow-card__body">
                        <span className="workflow-card__title-row">
                          <span className="workflow-card__title">{workflow.name}</span>
                          {workflow.requiresFiles ? <span className="workflow-card__badge">Needs user data</span> : null}
                        </span>
                        <span className="workflow-card__copy">{workflow.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        {selectedWorkflow ? (
          <aside className="workflow-detail">
            <div className="workflow-detail__header">
              <div>
                <p className="workflow-detail__eyebrow">{getCategoryLabel(selectedWorkflow.category)}</p>
                <h3 className="workflow-detail__title">{selectedWorkflow.name}</h3>
              </div>
              {selectedWorkflow.requiresFiles ? (
                <span className="workflow-card__badge">Files required on web</span>
              ) : null}
            </div>
            <p className="workflow-detail__copy">{selectedWorkflow.description}</p>

            {selectedWorkflow.placeholders.length > 0 ? (
              <div className="workflow-detail__fields">
                {selectedWorkflow.placeholders.map((placeholder) => (
                  <label className="workflow-field" key={placeholder.key}>
                    <span className="workflow-field__label">{placeholder.label}{placeholder.required ? " *" : ""}</span>
                    <input
                      className="workflow-field__input"
                      data-workflow-placeholder={placeholder.key}
                      onChange={(event) => {
                        setPlaceholderValues((current) => ({
                          ...current,
                          [placeholder.key]: event.currentTarget.value,
                        }));
                      }}
                      placeholder={placeholder.label}
                      type="text"
                      value={placeholderValues[placeholder.key] ?? ""}
                    />
                  </label>
                ))}
              </div>
            ) : null}

            <div className="workflow-field">
              <div className="workflow-field__header">
                <span className="workflow-field__label">{isEditingPrompt ? "Edit prompt" : "Prompt preview"}</span>
                <button
                  className="workflow-edit-toggle"
                  data-workflow-edit-toggle
                  onClick={() => {
                    if (!isEditingPrompt) {
                      setEditedPrompt(finalPrompt);
                    }
                    setIsEditingPrompt(!isEditingPrompt);
                  }}
                  type="button"
                >
                  {isEditingPrompt ? "Done" : "Edit"}
                </button>
              </div>
              {isEditingPrompt ? (
                <textarea
                  className="workflow-field__textarea"
                  data-workflow-prompt
                  onChange={(event) => setEditedPrompt(event.currentTarget.value)}
                  value={editedPrompt ?? assembledPrompt}
                />
              ) : (
                <div className="workflow-field__preview" data-workflow-preview>
                  {finalPrompt}
                </div>
              )}
            </div>

            {selectedWorkflow.suggestedSkills.length > 0 ? (
              <div className="workflow-skill-chips">
                {selectedWorkflow.suggestedSkills.map((skill) => (
                  <span className="workflow-skill-chip" key={skill}>{skill}</span>
                ))}
              </div>
            ) : null}

            <div className="workflow-controls-row">
              <label className="composer-control composer-control--select" aria-label="Workflow model selector">
                <select
                  className="composer-control__select"
                  data-workflow-model
                  onChange={(event) => setWorkflowModelId(event.currentTarget.value)}
                  value={workflowModelId}
                >
                  {MODELS.map((model) => (
                    <option key={model.id} value={model.id}>{model.label}</option>
                  ))}
                </select>
              </label>
              <label className="composer-control composer-control--select" aria-label="Workflow compute selector">
                <select
                  className="composer-control__select"
                  data-workflow-compute
                  onChange={(event) => setWorkflowComputeId(event.currentTarget.value)}
                  value={workflowComputeId}
                >
                  <option value={LOCAL_INSTANCE.id}>{LOCAL_INSTANCE.label}</option>
                  {COMPUTE_INSTANCES.map((instance) => (
                    <option disabled={!modalConfigured} key={instance.id} value={instance.id}>{instance.label}</option>
                  ))}
                </select>
              </label>
            </div>

            {launchDisabledReason ? <p className="workflow-launch-note">{launchDisabledReason}</p> : null}
            {selectedWorkflow.requiresFiles ? (
              <p className="workflow-launch-note">This VS Code port keeps workflow file upload out of scope for now; add any needed file context in the prompt or open the web app when upload-driven workflows are required.</p>
            ) : null}

            <button
              className="button workflow-run-button"
              data-workflow-run={selectedWorkflow.id}
              disabled={!canLaunch}
              onClick={() =>
                onLaunch({
                  prompt: finalPrompt,
                  modelId: workflowModelId,
                  computeId: workflowComputeId,
                  suggestedSkillIds: resolveSuggestedSkillIds(selectedWorkflow, availableSkills),
                })
              }
              type="button"
            >
              Run workflow
            </button>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
