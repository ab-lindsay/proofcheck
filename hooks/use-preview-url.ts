"use client";
import { useEffect, useState } from "react";

/** Turns a File into a revocable blob URL, re-creating it whenever `file` changes and revoking the
 *  previous URL on every change and on unmount. Shared by UploadZone's thumbnail and
 *  LabelImageViewer's trigger/modal so both depend on one lifecycle instead of two copies of it. */
export function usePreviewUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    // This effect creates and disposes of a browser resource (a blob URL) — synchronizing with an
    // external system, not deriving state from props — so calling setState here is the correct,
    // sanctioned pattern (react.dev/reference/react/useEffect#connecting-to-an-external-system), not
    // the "you might not need an effect" anti-pattern the rule otherwise guards against. Computing the
    // URL in useMemo instead (tried first) is impure and unsafe under Strict Mode double-invocation:
    // React can discard a useMemo call without ever running a cleanup for it, orphaning the blob.
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return url;
}
