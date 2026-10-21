// STUB_DIALOG — placeholder until the feature is implemented.
import { Dialog } from "../ui/Dialog";
import type { DialogProps } from "./DialogHost";

function Stub({ close, title }: DialogProps & { title: string }) {
  return (
    <Dialog title={title} onClose={close}>
      <p className="muted">This tool is being built.</p>
    </Dialog>
  );
}

export default function HeaderFooterDialog(p: DialogProps) {
  return <Stub {...p} title="HeaderFooterDialog" />;
}

export function PageNumbersDialog(p: DialogProps) {
  return <Stub {...p} title="PageNumbersDialog" />;
}

export function BatesDialog(p: DialogProps) {
  return <Stub {...p} title="BatesDialog" />;
}
