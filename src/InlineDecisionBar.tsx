import { AlertTriangle, Check, X } from "lucide-react";

export interface InlineDecisionPrompt {
  id: string;
  title: string;
  description: string;
  details?: string[];
  confirmLabel: string;
  cancelLabel?: string;
}

export default function InlineDecisionBar({
  prompt,
  onConfirm,
  onCancel
}: {
  prompt: InlineDecisionPrompt;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = `${prompt.id}-title`;
  const descriptionId = `${prompt.id}-description`;

  return (
    <section
      className="inline-decision-bar"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <span className="inline-decision-icon" aria-hidden="true">
        <AlertTriangle size={19} />
      </span>
      <div className="inline-decision-copy">
        <strong id={titleId}>{prompt.title}</strong>
        <p id={descriptionId}>{prompt.description}</p>
        {Boolean(prompt.details?.length) && (
          <ul>
            {prompt.details!.map((detail) => <li key={detail}>{detail}</li>)}
          </ul>
        )}
      </div>
      <div className="inline-decision-actions">
        <button type="button" className="secondary-btn" onClick={onCancel}>
          <X size={16} />{prompt.cancelLabel || "取消"}
        </button>
        <button type="button" className="primary-btn" onClick={onConfirm}>
          <Check size={16} />{prompt.confirmLabel}
        </button>
      </div>
    </section>
  );
}
