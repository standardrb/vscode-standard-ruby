To cut a release of the extension, you must login with vsce using the project's
[personal access
token](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token):

```
$ yarn vsce login testdouble
```

If you haven't, update the version:

```
$ yarn version --patch
$ git push && git push --tags
```

Next, you should just need to run:

```
$ yarn run vsce:publish
```

