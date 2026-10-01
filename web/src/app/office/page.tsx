import { OfficeWorkspace } from "@/components/office-workspace";
export default async function OfficePage({ searchParams }: { searchParams: Promise<{ path?: string; project?: string }> }) {
  const { path, project } = await searchParams;
  if (typeof path !== "string" || typeof project !== "string" || !path || !project || !/\.(docx|pptx|xlsx)$/i.test(path)) return <p className="p-8">Open a Word document, spreadsheet or presentation from the Kady file browser.</p>;
  return <OfficeWorkspace key={`${project}:${path}`} path={path} projectId={project} />;
}
