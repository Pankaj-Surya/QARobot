const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(readApiError(text, `GET ${path} failed with ${response.status}`));
  }

  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(readApiError(text, `POST ${path} failed with ${response.status}`));
  }

  return response.json() as Promise<T>;
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(readApiError(text, `POST ${path} failed with ${response.status}`));
  }

  return response.json() as Promise<T>;
}

export async function apiUploadWithProgress<T>(
  path: string,
  formData: FormData,
  onProgress: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiUrl}${path}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new Error("Upload response was not valid JSON."));
        }
        return;
      }

      reject(new Error(readApiError(xhr.responseText, `POST ${path} failed with ${xhr.status}`)));
    };

    xhr.onerror = () => reject(new Error("Upload failed because the network request could not complete."));
    xhr.onabort = () => reject(new Error("Upload was cancelled."));
    xhr.send(formData);
  });
}

export async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(readApiError(text, `DELETE ${path} failed with ${response.status}`));
  }

  return response.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(readApiError(text, `PUT ${path} failed with ${response.status}`));
  }

  return response.json() as Promise<T>;
}

function readApiError(text: string, fallback: string) {
  if (!text) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : text;
  } catch {
    return text;
  }
}
