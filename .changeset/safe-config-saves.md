---
'@mzwing/pi-permission-auto-review': patch
---

`/permission-auto-review` no longer saves or resets a config file through a symbolic link, so a repository whose `.pi` directory links to your global config cannot make a project edit change or delete the global file. Saves keep the file's existing permissions, use a uniquely named temporary file, and check once more for concurrent edits just before replacing the file. When the file changed while the command was open, saving applies your changes to the file as it is now. If the other edit changed a setting that you also changed, the save is refused and names the setting, and saving again keeps your value.
