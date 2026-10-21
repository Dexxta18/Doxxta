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

export default function LinkDialog(p: DialogProps) {
  return <Stub {...p} title="LinkDialog" />;
}
