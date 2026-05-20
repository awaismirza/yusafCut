import { Button } from "@/components/ui/button";
import { useUIStore, type EditorTool } from "@/stores/uiStore";
import { ArrowUpLeft, MoveHorizontal, PanelsLeftRight, Scissors } from "lucide-react";

const TOOLS: {
  id: EditorTool;
  label: string;
  shortcut: string;
  title: string;
  icon: typeof ArrowUpLeft;
}[] = [
  {
    id: "select",
    label: "Select",
    shortcut: "V",
    title: "Selection tool",
    icon: ArrowUpLeft,
  },
  {
    id: "razor",
    label: "Razor",
    shortcut: "C",
    title: "Razor tool",
    icon: Scissors,
  },
  {
    id: "slip",
    label: "Slip",
    shortcut: "Y",
    title: "Slip timing",
    icon: MoveHorizontal,
  },
  {
    id: "slide",
    label: "Slide",
    shortcut: "U",
    title: "Slide edit",
    icon: PanelsLeftRight,
  },
];

export function Toolbox() {
  const activeTool = useUIStore((s) => s.activeTool);
  const setActiveTool = useUIStore((s) => s.setActiveTool);

  return (
    <aside className="editor-toolbox" aria-label="Editing tools">
      {TOOLS.map((tool) => {
        const Icon = tool.icon;
        const active = activeTool === tool.id;
        return (
          <Button
            key={tool.id}
            type="button"
            size="icon"
            variant="ghost"
            aria-pressed={active}
            className={active ? "toolbox-button is-active" : "toolbox-button"}
            title={`${tool.title} (${tool.shortcut})`}
            onClick={() => setActiveTool(tool.id)}
          >
            <Icon className="h-4 w-4" />
            <span>{tool.shortcut}</span>
          </Button>
        );
      })}
    </aside>
  );
}
