import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

function ExtensionPromptModal({
  show,
  dontShowAgain,
  onChangeDontShowAgain,
  onGetExtension,
  onSkip,
  onDismiss,
}) {
  const handleOpenChange = (nextOpen) => {
    if (!nextOpen) onDismiss()
  }

  return (
    <Dialog open={show} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-130">
        <DialogTitle className="text-xl">Use Traker Extension?</DialogTitle>
        <DialogDescription className="text-sm text-foreground">
          Install our Chrome extension for more accurate price tracking with
          a visual picker.
        </DialogDescription>

        <label className="extPromptCheck">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => onChangeDontShowAgain(e.target.checked)}
          />
          Don't show this again
        </label>

        <div className="extPromptActions">
          <button className="primaryBtn" type="button" onClick={onGetExtension}>
            Get Extension
          </button>
          <button className="secondaryBtn" type="button" onClick={onSkip}>
            Skip, use automatic detection
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ExtensionPromptModal
