"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const mappingKeys = [
  { key: "businessName", label: "Business Name" },
  { key: "contactName", label: "Contact Name" },
  { key: "phoneNumber", label: "Phone Number" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "niche", label: "Niche/Industry" },
  { key: "website", label: "Website" },
  { key: "notes", label: "Notes" },
] as const;

type MappingState = Record<(typeof mappingKeys)[number]["key"], string>;

type CsvRow = Record<string, string>;

function guessMapping(headers: string[]): MappingState {
  const lowerHeaders = headers.map((header) => header.toLowerCase());

  function findMatch(candidates: string[]) {
    const index = lowerHeaders.findIndex((header) => candidates.some((candidate) => header.includes(candidate)));
    return index >= 0 ? headers[index] : "";
  }

  return {
    businessName: findMatch(["business", "company", "organization", "clinic"]),
    contactName: findMatch(["contact", "owner", "first name", "name"]),
    phoneNumber: findMatch(["phone", "mobile", "tel"]),
    city: findMatch(["city"]),
    state: findMatch(["state", "province"]),
    niche: findMatch(["industry", "niche", "category"]),
    website: findMatch(["website", "url", "domain"]),
    notes: findMatch(["note", "comment"]),
  };
}

export default function ImportPage() {
  const [sourceFileName, setSourceFileName] = useState("");
  const [leadListName, setLeadListName] = useState("");
  const [locations, setLocations] = useState<string[]>([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [csvText, setCsvText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rowsPreview, setRowsPreview] = useState<CsvRow[]>([]);
  const [mapping, setMapping] = useState<MappingState>({
    businessName: "",
    contactName: "",
    phoneNumber: "",
    city: "",
    state: "",
    niche: "",
    website: "",
    notes: "",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<null | {
    totalRows: number;
    importedRows: number;
    skippedRows: number;
    duplicateRows: number;
  }>(null);
  const [error, setError] = useState<string | null>(null);

  const mappingOptions = useMemo(() => ["", ...headers], [headers]);

  useEffect(() => {
    async function loadLocations() {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const payload = (await response.json()) as { settings?: { locations?: string[] } };

      if (!response.ok) {
        return;
      }

      const nextLocations = payload.settings?.locations ?? [];
      setLocations(nextLocations);
      setSelectedLocation((current) => current || nextLocations[0] || "");
    }

    void loadLocations();
  }, []);

  async function handleFileChange(file: File) {
    const text = await file.text();

    const parsed = Papa.parse<CsvRow>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim(),
    });

    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors[0]?.message ?? "Could not parse CSV file");
    }

    const parsedHeaders = parsed.meta.fields ?? [];

    if (parsedHeaders.length === 0) {
      throw new Error("No headers detected in CSV file");
    }

    setSourceFileName(file.name);
    setLeadListName(file.name.replace(/\.csv$/i, "") || `Lead List ${new Date().toLocaleDateString()}`);
    setCsvText(text);
    setHeaders(parsedHeaders);
    setRowsPreview(parsed.data.slice(0, 5));
    setMapping(guessMapping(parsedHeaders));
  }

  async function submitImport() {
    setError(null);

    if (!csvText) {
      setError("Upload a CSV file first.");
      return;
    }

    if (!mapping.phoneNumber) {
      setError("Phone Number mapping is required.");
      return;
    }

    if (!selectedLocation) {
      setError("Choose a location before importing leads.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/import/csv", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          leadListName,
          location: selectedLocation,
          sourceFileName,
          csvText,
          mapping,
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        summary?: {
          totalRows: number;
          importedRows: number;
          skippedRows: number;
          duplicateRows: number;
        };
      };

      if (!response.ok || !payload.summary) {
        throw new Error(payload.error ?? "Import failed");
      }

      setResult(payload.summary);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Lead Import</CardTitle>
          <CardDescription>Upload CSV, map columns, preview rows, then import into a new lead list.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="csv-file">CSV file</Label>
              <Input
                id="csv-file"
                accept=".csv,text/csv"
                type="file"
                onChange={async (event) => {
                  const file = event.target.files?.[0];

                  if (!file) {
                    return;
                  }

                  try {
                    await handleFileChange(file);
                  } catch (parseError) {
                    setError(parseError instanceof Error ? parseError.message : "CSV parse failed");
                  }
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="lead-list-name">Lead list name</Label>
              <Input id="lead-list-name" value={leadListName} onChange={(event) => setLeadListName(event.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Location</Label>
              <Select value={selectedLocation || "__none__"} onValueChange={(value) => setSelectedLocation(value === "__none__" ? "" : value)}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose location" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Choose location</SelectItem>
                  {locations.map((location) => (
                    <SelectItem key={location} value={location}>
                      {location}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!locations.length ? <p className="text-xs text-amber-700">Add locations in Settings before importing.</p> : null}
            </div>
          </div>

          {headers.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {mappingKeys.map((item) => (
                <div key={item.key} className="space-y-2">
                  <Label>{item.label}</Label>
                  <Select
                    value={mapping[item.key] || "__none__"}
                    onValueChange={(value) => {
                      setMapping((prev) => ({
                        ...prev,
                        [item.key]: value === "__none__" ? "" : value,
                      }));
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Not mapped" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Not mapped</SelectItem>
                      {mappingOptions
                        .filter((header) => header)
                        .map((header) => (
                          <SelectItem key={`${item.key}-${header}`} value={header}>
                            {header}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          ) : null}

          {rowsPreview.length > 0 ? (
            <div className="rounded-lg border border-slate-200">
              <div className="border-b bg-slate-50 px-3 py-2 text-sm font-medium">Preview (first 5 rows)</div>
              <div className="overflow-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr>
                      {headers.map((header) => (
                        <th className="border-b px-3 py-2 text-left" key={header}>
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rowsPreview.map((row, index) => (
                      <tr className="odd:bg-white even:bg-slate-50" key={`row-${index}`}>
                        {headers.map((header) => (
                          <td className="px-3 py-2" key={`${index}-${header}`}>
                            {row[header] || "-"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <Button disabled={!csvText || !selectedLocation} loading={loading} onClick={submitImport}>
              {loading ? "Importing..." : "Confirm Import"}
            </Button>
            {error ? <p className="text-sm text-red-700">{error}</p> : null}
          </div>

          {result ? (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
              <p className="font-medium">Import complete</p>
              <p>Total rows: {result.totalRows}</p>
              <p>Imported rows: {result.importedRows}</p>
              <p>Skipped rows: {result.skippedRows}</p>
              <p>Duplicate rows: {result.duplicateRows}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
