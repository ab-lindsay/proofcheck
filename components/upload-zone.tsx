"use client";
import { useCallback, useRef, useState } from "react";
import { Camera, UploadCloud } from "lucide-react";
import { usePreviewUrl } from "@/hooks/use-preview-url";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export function UploadZone({
  file,
  onFile,
  previewSrc,
}: {
  file: File | null;
  onFile: (f: File | null) => void;
  // Preview URL for a parent-set file (e.g. a bundled sample served from /samples). For user uploads
  // this is undefined and the zone makes an object URL itself.
  previewSrc?: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);

  // A rejected file may have come from either input (the regular picker or the camera capture one) —
  // clear both so a resubmit of the same filename still fires onChange.
  const clearInputs = useCallback(() => {
    if (inputRef.current) inputRef.current.value = "";
    if (cameraInputRef.current) cameraInputRef.current.value = "";
  }, []);

  const choose = useCallback(
    (f: File | null) => {
      setRejectMsg(null);
      if (!f) {
        setSelectedFile(null);
        onFile(null);
        return;
      }
      if (!ALLOWED_MIME.has(f.type)) {
        clearInputs();
        setRejectMsg(`Unsupported format (${f.type || "unknown"}). Please upload a PNG, JPEG, or WebP image.`);
        onFile(null);
        return;
      }
      if (f.size > 8 * 1024 * 1024) {
        clearInputs();
        setRejectMsg(`Image is too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Maximum is 8 MB.`);
        onFile(null);
        return;
      }
      setSelectedFile(f);
      onFile(f);
    },
    [onFile, clearInputs],
  );

  const objectUrl = usePreviewUrl(selectedFile);
  const preview = previewSrc ?? objectUrl;

  return (
    <div
      className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 ${
        dragOver ? "border-proof bg-accent" : "border-border bg-muted/60"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        choose(e.dataTransfer.files[0] ?? null);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        aria-label="Label image"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={(e) => choose(e.target.files?.[0] ?? null)}
      />
      {/* capture="environment" opens the rear camera directly on mobile instead of the gallery
          picker; desktop browsers ignore it and this behaves like a normal file input. */}
      <input
        ref={cameraInputRef}
        type="file"
        aria-label="Take a photo"
        accept="image/png,image/jpeg,image/webp"
        capture="environment"
        className="sr-only"
        onChange={(e) => choose(e.target.files?.[0] ?? null)}
      />
      {rejectMsg ? (
        <p role="alert" className="text-base font-medium text-verdict-non-compliant">
          {rejectMsg}
        </p>
      ) : null}
      {preview ? (
        <div className="space-y-3">
          {/* Fixed-height box reserves layout space so the preview swapping in causes no shift (CLS). */}
          <div className="mx-auto flex h-64 items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- object URL / sample preview */}
            <img
              src={preview}
              alt={`Preview of ${file?.name ?? "label"}`}
              className="max-h-64 max-w-full rounded-lg border border-border object-contain shadow-sm"
            />
          </div>
          <p className="text-base font-medium text-muted-foreground">{file?.name}</p>
          <button
            type="button"
            className="text-base font-medium text-ring underline underline-offset-2 hover:opacity-80"
            onClick={() => {
              choose(null);
              clearInputs();
            }}
          >
            Remove image
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UploadCloud aria-hidden className="h-6 w-6" />
          </span>
          <p className="text-xl font-medium text-foreground">Drop the label image here</p>
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
            <button
              type="button"
              className="text-lg font-medium text-ring underline underline-offset-2 hover:opacity-80"
              onClick={() => inputRef.current?.click()}
            >
              Choose a file
            </button>
            <span className="text-muted-foreground">or</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-lg font-medium text-ring underline underline-offset-2 hover:opacity-80"
              onClick={() => cameraInputRef.current?.click()}
            >
              <Camera aria-hidden className="h-4 w-4" />
              Take a photo
            </button>
          </div>
          <p className="text-base text-muted-foreground">PNG, JPEG, or WebP — up to 8 MB</p>
        </div>
      )}
    </div>
  );
}
