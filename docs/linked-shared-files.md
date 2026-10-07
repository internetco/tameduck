# Linked shared files

`computer_export_file` creates a stable shared file inside the current conversation or ticket. Its `url` / `download_url` points to the latest encrypted version. The returned `upload_id` and `/api/uploads/:id` URL identify one immutable version and remain valid for old chat links. Re-exporting the same verified source in the same scope updates that shared file; unchanged bytes add no version.

The computer janitor inventories only already-running computers with linked sources or registered output folders. It waits for two matching observations before copying a change, verifies the file during transfer, and waits for two complete scans before archiving a missing source. Failed, unsafe, interrupted and offline scans leave the last stored copy alone. The source is bound to a provider box ID; a replacement box cannot silently update the previous shared file. Manual archive stays archived until restore or explicit re-share. Restoring a file whose original is still missing keeps the stored copy in Current until the original returns. Sync does not touch computer activity or start/resume it. See [Published folders](published-folders.md) for directory synchronization, empty-folder visibility, and organization controls.

`GET /api/files` includes one `kind: "shared_file"`, `grouped: true` item per source the viewer can access, with `archived`, `current_upload_id`, `version_count`, `can_manage`, a stable `download_url`, and all accessible chat/ticket `places`. Source identity includes company, duck, computer, provider box and full source path; equal names or contents alone never combine files. Rows with a removed computer stay separate. Existing duplicates are grouped on read, without a data migration or deleting uploads. Once rename sync updates the paths, the same grouping applies at the new path.

Sharing from different chats/tickets still keeps separate scope records and version histories. These are access grants, not separate rows in Files: merging them globally would expose private chat history to other audiences. Grouping filters for access first. `GET /api/shared-file-groups/:id` returns the combined metadata and newest-first immutable versions from only those accessible scopes; `?download=1` serves the latest accessible active copy, or the latest stored copy when every scope is archived. The group ID is its oldest accessible scope ID. Archive/restore timestamps do not supersede the time the current bytes were saved or explicitly re-shared. A group is Archived only when every accessible scope is archived. Group `POST /archive` and `/restore` atomically manage all accessible scopes, requiring original-uploader rights for every one or company admin access; inaccessible scopes are untouched. The UI offers navigation to every accessible placement.

Existing scoped URLs are unchanged: `GET /api/shared-files/:id` returns that scope's metadata and newest-first immutable `versions`; `?download=1` serves its current version. Its `POST /archive` and `/restore` require original uploader or company admin access. The duck can use `shared_file_list` and `shared_file_manage` within its conversation or ticket after a person asks. Individual historical versions still download through `/api/uploads/:upload_id?download=1` with their original authorization. Group history neither broadens those permissions nor reveals inaccessible version counts or locations.

## Reviewed legacy export adoption

`adoptExistingExports` in `server/shared-files.mjs` is an operator-only helper. It takes an explicit, ordered array of reviewed legacy `computer_file_exports` upload IDs. It validates one company, duck, conversation and ticket scope, verifies the current source through `readComputerFile`, links every old encrypted upload as an immutable version, and preserves every old upload and URL. It does not infer membership from filenames or delete blobs. Because the current computer source may differ from the last stored legacy upload, the adopted record is marked unsynced; the next two complete scans verify and add the latest source bytes. Run it only from a deployed release against the intended data directory after reviewing the exact IDs and source binding. Example call shape:

```js
const source = await readComputerFile({ request, boxId, filePath });
source.computer_id = computerId;
source.source_box_id = boxId;
const sharedId = await adoptExistingExports({
  companyId,
  computerId,
  boxId,
  conversationId,
  taskId: null,
  duckId,
  source,
  uploadIds: reviewedOldestToNewestIds,
});
```

A repeat call with those IDs is rejected because each version can belong to one shared file. The helper makes no change until its validation and full source read succeed.
