import { allCommands, getCommand, isEnabled, runCommand } from "../../core/commands";
import type { MenuItem } from "../ui/Menu";
import { useRecent, getRecentFile } from "../../lib/recent";
import { openBytes } from "../../core/document";
import { openDialog, toast } from "../../state/store";
import { FileText, FileSpreadsheet, Presentation, FileImage, FileType, FileCode, Clock } from "lucide-react";

export function cmd(id: string, overrides: Partial<{ label: string }> = {}): MenuItem {
  const c = getCommand(id);
  return {
    label: overrides.label ?? c.label,
    icon: c.icon,
    shortcut: c.shortcut,
    disabled: !isEnabled(c),
    checked: c.checked ? c.checked() : undefined,
    onSelect: () => runCommand(id),
  };
}

const sep: MenuItem = { type: "separator" };

function recentItems(): MenuItem[] {
  const entries = useRecent.getState().entries.slice(0, 10);
  if (!entries.length) return [{ label: "No recent files", disabled: true, onSelect: () => {} }];
  return entries.map((e) => ({
    label: e.name,
    icon: <Clock size={15} />,
    onSelect: async () => {
      const f = await getRecentFile(e.id);
      if (!f) {
        toast("That file is no longer available offline. Open it again from disk.", "warning");
        return;
      }
      await openBytes(f.bytes, e.name, { fileHandle: f.handle });
    },
  }));
}

const exportItem = (label: string, format: string, icon: React.ReactNode): MenuItem => ({
  label,
  icon,
  disabled: !isEnabled(getCommand("file.export")),
  onSelect: () => openDialog("export", { format }),
});

export function fileMenu(): MenuItem[] {
  return [
    cmd("file.open"),
    cmd("file.openUrl"),
    { type: "submenu", label: "Open recent", items: recentItems },
    sep,
    {
      type: "submenu",
      label: "Create PDF",
      items: () => [cmd("file.createBlank"), cmd("file.createImages"), cmd("file.createText"), cmd("file.createClipboard"), cmd("file.createCamera")],
    },
    cmd("file.combine"),
    sep,
    cmd("file.save"),
    cmd("file.saveAs"),
    {
      type: "submenu",
      label: "Export to",
      items: () => [
        exportItem("Microsoft Word (.docx)", "docx", <FileText size={15} />),
        exportItem("Microsoft Excel (.xlsx)", "xlsx", <FileSpreadsheet size={15} />),
        exportItem("Microsoft PowerPoint (.pptx)", "pptx", <Presentation size={15} />),
        exportItem("Image (PNG / JPEG / WebP)", "image", <FileImage size={15} />),
        exportItem("Plain text (.txt)", "txt", <FileType size={15} />),
        exportItem("Web page (.html)", "html", <FileCode size={15} />),
        exportItem("Markdown (.md)", "md", <FileCode size={15} />),
      ],
    },
    sep,
    cmd("file.print"),
    sep,
    cmd("file.properties"),
    sep,
    cmd("file.revert"),
    cmd("file.close"),
    cmd("file.closeAll"),
  ];
}

export function editMenu(): MenuItem[] {
  return [
    cmd("edit.undo"),
    cmd("edit.redo"),
    sep,
    cmd("edit.cut"),
    cmd("edit.copy"),
    cmd("edit.paste"),
    cmd("edit.duplicate"),
    cmd("edit.delete"),
    sep,
    cmd("edit.selectAll"),
    sep,
    cmd("edit.find"),
    cmd("edit.search"),
    sep,
    cmd("edit.preferences"),
  ];
}

export function viewMenu(): MenuItem[] {
  return [
    {
      type: "submenu",
      label: "Zoom",
      items: () => [cmd("view.zoomIn"), cmd("view.zoomOut"), sep, cmd("view.fitPage"), cmd("view.actualSize"), cmd("view.fitWidth"), cmd("view.fitAuto"), sep, cmd("view.marqueeZoom")],
    },
    { type: "submenu", label: "Rotate view", items: () => [cmd("view.rotateCw"), cmd("view.rotateCcw")] },
    {
      type: "submenu",
      label: "Page navigation",
      items: () => [cmd("view.firstPage"), cmd("view.prevPage"), cmd("view.nextPage"), cmd("view.lastPage"), sep, cmd("view.goToPage")],
    },
    {
      type: "submenu",
      label: "Page display",
      items: () => [
        cmd("view.singlePage"),
        cmd("view.continuous"),
        cmd("view.twoPage"),
        cmd("view.twoPageScroll"),
        cmd("view.coverPage"),
        sep,
        cmd("view.horizontal"),
        cmd("view.wrapped"),
      ],
    },
    sep,
    cmd("view.toolsPanel"),
    cmd("view.sidePanel"),
    sep,
    cmd("view.readMode"),
    cmd("view.fullscreen"),
    cmd("view.presentation"),
    sep,
    {
      type: "submenu",
      label: "Page colors",
      items: () => [cmd("view.pageThemeNormal"), cmd("view.pageThemeNight"), cmd("view.pageThemeSepia"), cmd("view.pageThemeContrast")],
    },
    { type: "submenu", label: "App theme", items: () => [cmd("view.themeLight"), cmd("view.themeDark"), cmd("view.themeSystem")] },
    sep,
    cmd("view.readAloud"),
  ];
}

export function toolsMenu(): MenuItem[] {
  return [
    { type: "header", label: "Review" },
    cmd("mode.comment"),
    cmd("tool.stamps"),
    { type: "submenu", label: "Comments", items: () => [cmd("tool.importComments"), cmd("tool.exportComments"), cmd("tool.summarizeComments")] },
    cmd("tool.compare"),
    cmd("mode.measure"),
    { type: "header", label: "Forms & signatures" },
    cmd("mode.fillsign"),
    cmd("mode.forms"),
    { type: "submenu", label: "Form data", items: () => [cmd("tool.exportFormData"), cmd("tool.importFormData"), cmd("tool.resetForm")] },
    cmd("tool.signatures"),
    { type: "header", label: "Edit & organize" },
    cmd("mode.edit"),
    cmd("mode.organize"),
    cmd("tool.insertPages"),
    cmd("tool.extractPages"),
    cmd("tool.split"),
    cmd("file.combine"),
    {
      type: "submenu",
      label: "Page marks",
      items: () => [cmd("tool.watermark"), cmd("tool.headerFooter"), cmd("tool.pageNumbers"), cmd("tool.bates"), cmd("tool.background")],
    },
    cmd("tool.crop"),
    { type: "header", label: "Protect & optimize" },
    cmd("mode.protect"),
    cmd("mode.redact"),
    cmd("tool.sanitize"),
    cmd("tool.flatten"),
    cmd("tool.compress"),
    cmd("tool.ocr"),
    cmd("tool.export"),
    sep,
    cmd("tool.snapshot"),
  ];
}

export function helpMenu(): MenuItem[] {
  return [cmd("help.shortcuts"), cmd("help.about")];
}

export const MENUS: { label: string; items: () => MenuItem[] }[] = [
  { label: "File", items: fileMenu },
  { label: "Edit", items: editMenu },
  { label: "View", items: viewMenu },
  { label: "Tools", items: toolsMenu },
  { label: "Help", items: helpMenu },
];

export { allCommands };
