import { lazy, Suspense, type ComponentType } from "react";
import { closeDialog, useApp } from "../../state/store";

export interface DialogProps<P = Record<string, unknown>> {
  props: P;
  close: () => void;
}

type Lazy = ComponentType<DialogProps<never>>;
const L = (f: () => Promise<{ default: ComponentType<DialogProps<never>> }>) => lazy(f) as unknown as Lazy;

const REGISTRY: Record<string, Lazy> = {
  password: L(() => import("./BasicDialogs").then((m) => ({ default: m.PasswordDialog }))),
  "confirm-close": L(() => import("./BasicDialogs").then((m) => ({ default: m.ConfirmCloseDialog }))),
  confirm: L(() => import("./BasicDialogs").then((m) => ({ default: m.ConfirmDialog }))),
  "open-url": L(() => import("./BasicDialogs").then((m) => ({ default: m.OpenUrlDialog }))),
  "goto-page": L(() => import("./BasicDialogs").then((m) => ({ default: m.GoToPageDialog }))),
  shortcuts: L(() => import("./BasicDialogs").then((m) => ({ default: m.ShortcutsDialog }))),
  about: L(() => import("./BasicDialogs").then((m) => ({ default: m.AboutDialog }))),
  preferences: L(() => import("./PreferencesDialog")),
  "save-as": L(() => import("./SaveAsDialog")),
  print: L(() => import("./PrintDialog")),
  properties: L(() => import("./PropertiesDialog")),
  export: L(() => import("./ExportDialog")),
  create: L(() => import("./CreateDialog")),
  camera: L(() => import("./CameraDialog")),
  combine: L(() => import("./CombineDialog")),
  compress: L(() => import("./CompressDialog")),
  ocr: L(() => import("./OcrDialog")),
  split: L(() => import("./SplitDialog")),
  "insert-pages": L(() => import("./InsertPagesDialog")),
  "extract-pages": L(() => import("./ExtractPagesDialog")),
  watermark: L(() => import("./WatermarkDialog")),
  "header-footer": L(() => import("./HeaderFooterDialog")),
  "page-numbers": L(() => import("./HeaderFooterDialog").then((m) => ({ default: m.PageNumbersDialog }))),
  bates: L(() => import("./HeaderFooterDialog").then((m) => ({ default: m.BatesDialog }))),
  background: L(() => import("./BackgroundDialog")),
  crop: L(() => import("./CropDialog")),
  link: L(() => import("./LinkDialog")),
  "link-view": L(() => import("./LinkDialog").then((m) => ({ default: m.LinkViewPicker }))),
  protect: L(() => import("./ProtectDialog")),
  "remove-security": L(() => import("./ProtectDialog").then((m) => ({ default: m.RemoveSecurityDialog }))),
  sanitize: L(() => import("./SanitizeDialog")),
  flatten: L(() => import("./SanitizeDialog").then((m) => ({ default: m.FlattenDialog }))),
  signature: L(() => import("./SignatureDialog")),
  "custom-stamp": L(() => import("./SignatureDialog").then((m) => ({ default: m.CustomStampDialog }))),
  "annot-props": L(() => import("./AnnotPropsDialog")),
  "form-data": L(() => import("./FormDataDialog")),
  "search-redact": L(() => import("./RedactDialogs")),
  "apply-redactions": L(() => import("./RedactDialogs").then((m) => ({ default: m.ApplyRedactionsDialog }))),
  "measure-scale": L(() => import("./MeasureScaleDialog")),
  "compare-setup": L(() => import("./CompareDialog")),
};

export function DialogHost() {
  const dialogs = useApp((s) => s.dialogs);
  return (
    <>
      {dialogs.map((d) => {
        const C = REGISTRY[d.id];
        if (!C) return null;
        return (
          <Suspense key={d.id} fallback={null}>
            <C props={(d.props ?? {}) as never} close={() => closeDialog(d.id)} />
          </Suspense>
        );
      })}
    </>
  );
}
