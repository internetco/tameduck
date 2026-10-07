# Published folders

Folders organize the Files page, a duck's Files page, a chat's Files view, and a ticket's Files & documents tab. Folder selection is kept in the URL. Documents and attachments use the same selection on a ticket. All files and Unfiled remain available alongside the folder tree.

Computer folders represent directories under the owning duck's `~/tameduck/outputs`. Publishing a file registers its parent directories in the current conversation and ticket. `folder_create` can create or register a directory before it contains any files. Registered empty folders have their own access and placement records and remain visible after their last item is moved out. Private computer directories outside outputs are not exposed.

Folder records are cached in the app, so navigation, saved documents, uploads, and stored shared-file downloads work while a computer sleeps. Running-computer synchronization also discovers empty descendants of registered folders. Creating or changing a physical directory requires access to that duck's current computer; a record tied to an old provider box cannot operate on a replacement computer. Human folder operations wait while the duck is working or a person has taken control of the computer.

App-only folders organize documents, uploads, notes, and screenshots without requiring a computer. Placement changes the Files organization metadata and leaves stored bytes in place. Moving a linked computer file moves its source directory entry, while its stable ID, version history, and chat/ticket associations are retained. Renaming a physical folder updates its descendants and linked source paths together. Folders never grant additional access to a private file.

Use the folder controls or duck tools to rename published folders and move files. A directory renamed directly in a terminal is not reconciled to its old folder record; later source publication or synchronization can register the new path while the old record remains. This preserves cached documents and intentional empty folders rather than guessing that two directory names represent the same folder.

Deleting a folder removes only an empty folder. The server checks registered subfolders and app items, and the computer refuses removal when any entry remains, including hidden or unpublished files. Folder deletion does not recursively delete files or subfolders. Intentionally empty folders stay until someone deletes them; hiding an empty folder is not deletion.

## Duck tools

- file_list: list the files available for organization, with stable typed file_id values, existing folder placement, source scopes, move eligibility, and pagination. It includes the duck's own published work across chats the requesting person can access and files in the currently authorized chat or ticket. Read all pages before organizing.
- files_move: move up to 50 returned file_id values to one existing folder or a folder_path. A path is created or reused under published outputs. Results are reported per file so failures do not look like successes. Re-list to verify final placement.
- folder_list: list accessible folders, including empty folders and their IDs.
- folder_create: create/register a folder, optionally below parent_id; use computer: false for a logical app-only folder.
- folder_rename: rename a folder by ID.
- folder_delete: remove a folder only when empty.
- file_move: legacy single-file move by kind and ID. Supported kinds include documents, uploads, linked shared files, screenshots, and notes.
- shared_file_list and shared_file_manage: inspect linked computer exports and archive or restore them. Use file_list as the complete organization catalog.
- document_save: optional folder_id; omission retains the existing placement when updating. The optimistic content-version check remains in force.
- computer_export_file: parent directories register automatically; an optional folder_id must match the actual source directory.

When asked to organize, ducks should read every inventory page, reuse suitable folders, and use a small number of clear paths. Linked output files move on their computer. App-only uploads, documents, notes, and screenshots receive folder placement without changing their stored bytes. Ducks must re-list after moving and report anything that remains unfiled or failed. Moving a file never deletes its contents. Temporary empty folders created for the task may be removed; intentional empty folders remain.

## API and storage

`/api/file-folders` lists and creates folders. `PATCH /api/file-folders/:id` renames and `DELETE` removes an empty folder. `POST /api/file-folders/:id/items` moves an item; `unfiled` is the destination sentinel. Existing file responses retain their fields and add `folder_id`; aggregate Files and ticket attachments also return `folders`. Uploads accept `X-Folder-Id`; document creation and edits accept `folder_id`.

Migration `0033_file-folders.sql` adds folder, scope, and placement tables without changing the positional document schema or rewriting uploaded bytes. Physical identity preserves Linux path case and Unicode spelling. Computer mutations use directory handles, reject symlinks and special files, and refuse to overwrite a destination. Inventory scans have explicit depth and entry limits.

Migration `0035_unified-file-organization.sql` extends folder placements to include screenshots and notes, and tracks materialized linked directories by folder, computer, and source box. It preserves existing placements and does not rewrite file contents.

The focused tests cover empty and nested directories, hidden contents, path safety, collisions, exact physical identity, access boundaries, immutable downloads, ticket associations, document save conflicts, duck tool receipts, and browser navigation and organization.
