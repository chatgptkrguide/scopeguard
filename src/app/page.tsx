import { Workspace } from "@/components/Workspace";
import { sampleProject } from "@/lib/sample";

export default function Home() {
  return <Workspace project={sampleProject} />;
}
