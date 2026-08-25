# Putting your tracker on the internet

A step-by-step guide, assuming you have never done anything like this before.

**Time:** about 20 minutes, plus 10 minutes of waiting at the end.
**Do this on a laptop or desktop computer**, not a phone.

---

## What we are actually doing

Right now the tracker is a set of files sitting on your Desktop. It works, but
only on this one computer.

We are going to put a copy of those files on a free service called **GitHub**,
and then flip a switch that turns them into a real website with its own address.
Once that is done you can open it on your phone, on any computer, anywhere.

```
   Your Desktop folder   →   GitHub   →   A real website address
                                          https://yourname.github.io/mtg-ff-tracker/
```

**Your card collection is not part of this.** These files are just the tracker
itself — the layout, the card pictures, the buttons. What you actually own gets
stored separately in your own Google Sheet, which stays private. That is a
different guide, and you do it after this one.

---

## Before you start

You need:

- [ ] The **MTG** folder on your Desktop (you already have this)
- [ ] An email address you can check right now
- [ ] About 20 minutes

---

## A few words you will see

You do not need to understand these deeply. Just enough to recognise them.

| Word | What it means here |
|---|---|
| **GitHub** | A free website that stores files, and can turn them into a website |
| **Repository** | GitHub's word for one project's folder. You are making one, and it will hold the tracker. People often shorten it to "repo" |
| **Public** | Anyone can look at the files. That is fine — your collection is not in them |
| **Commit** | GitHub's word for **save**. When you see a button saying "Commit changes", it just means "save this" |
| **GitHub Pages** | The free feature that turns your files into a working website |

---

# Step 1 — Make a GitHub account

*Already have one? Skip to Step 2.*

1. Open your web browser.

2. Click in the address bar at the top and type:

   ```
   github.com/signup
   ```

   Press **Enter**.

3. Type your email address, then click **Continue**.

4. Make up a password, then click **Continue**.

5. Choose a username.

   > ⚠️ **This becomes part of your website address**, so pick something you are
   > happy for other people to see.
   >
   > Stick to lowercase letters and numbers — no spaces, no capitals.
   >
   > For example, if you choose `carincards`, your tracker will end up at
   > `https://carincards.github.io/mtg-ff-tracker/`

6. Click **Continue** and follow the remaining questions. It may ask you to solve
   a small puzzle to prove you are a person.

7. **GitHub will email you a code. Go and get it, and type it in.**

   > ⚠️ **Do not skip this.** If your email address is never confirmed, the
   > website in Step 5 will silently never appear, and nothing will tell you why.
   > This trips up more people than anything else in this guide.

✅ **You are done with this step when:** you are logged in and looking at
GitHub's home page.

---

# Step 2 — Make a place for your files

1. Click in the address bar and type:

   ```
   github.com/new
   ```

   Press **Enter**.

   You will see a form for creating a new repository.

2. **Owner** — leave this alone. It should already show your username.

3. **Repository name** — type exactly this:

   ```
   mtg-ff-tracker
   ```

   No spaces. No capital letters. This becomes part of your web address, so keep
   it simple.

4. **Description** — optional. You can type something like
   *My Final Fantasy Magic card collection* or leave it empty.

5. **Visibility** — choose **Public**.

   > **Is that safe?** Yes. What goes here is the tracker itself — the page
   > layout, the buttons, the list of which cards exist in the world. It has to
   > be public because GitHub only gives free websites to public repositories.
   >
   > Your actual collection — what you own, what it is worth, where you keep it —
   > is never stored here. That goes in your private Google Sheet later.

6. Find the option called **Add README** and turn it **On**.

   > This just creates one starter file so your repository is not completely
   > empty. It makes the next steps work more smoothly.

7. Leave everything else exactly as it is.

8. Scroll to the bottom and click the green **Create repository** button.

✅ **You are done with this step when:** you are looking at a page with your
repository name at the top and a single file listed called `README.md`.

**Leave this page open.**

---

# Step 3 — Copy your files to GitHub

This is the longest step. Read it through once before starting.

### First, open your folder

1. Open **File Explorer** (the yellow folder icon on your taskbar).

2. Go to your **Desktop**, and **double-click the MTG folder to open it**.

   You should now be looking at the files *inside* it — `index.html`,
   `style.css`, `app.js`, and so on, plus some folders like `icons`.

   > ⚠️ **This bit matters.** You need the files **inside** the MTG folder — not
   > the MTG folder itself. If you accidentally send the folder, the website will
   > not work. There is a fix in the troubleshooting section if this happens.

### Then, start the upload

3. Go back to your browser, to your repository page.

4. Above the list of files, click the **Add file** button, then click
   **Upload files**.

   You will land on a mostly empty page with a large dashed box on it.

### Now move the files across

5. Arrange your windows so you can see **both** the File Explorer window and the
   browser window at the same time.

   *Tip: click the File Explorer window and press the Windows key + Left arrow,
   then click the browser window and press Windows key + Right arrow. That puts
   one on each side of the screen.*

6. Click once on any file in the File Explorer window, then press
   **Ctrl + A** to select everything.

   Everything should now be highlighted — about 24 items.

7. **Drag** the highlighted files across into the big dashed box in the browser,
   and let go.

8. Wait. A list will build up on the page, one line per file. There are about 32
   files in total and roughly 3.5 MB, so give it a minute or two.

   > Nothing appearing? Your browser may not accept dragged folders. See
   > **"The drag and drop did not work"** in troubleshooting.

### Finally, save it

9. Scroll to the bottom of the page. There is a text box for a short message.
   Type:

   ```
   First upload
   ```

10. Click the green **Commit changes** button.

11. Wait again. When it finishes, you will be back on your repository's file
    list, and this time it will be full of your files.

✅ **You are done with this step when:** you can see `index.html`, `style.css`,
`app.js` and `cards_data.js` in the list, along with folders named `icons`,
`tools` and `google-apps-script`.

---

# Step 4 — Check one small file arrived

There is one file that is easy to lose along the way. It takes 30 seconds to
check.

1. Look at the top of your file list. Files whose names start with a dot appear
   first.

2. Look for one called **`.nojekyll`**.

**If you can see it — you are done. Skip to Step 5.**

**If it is missing**, add it by hand:

1. Click **Add file**, then **Create new file**.
2. In the file name box, type exactly: `.nojekyll`
   *(Yes, it starts with a dot, and no, it has no ending.)*
3. Leave the big text area completely empty.
4. Scroll down and click **Commit changes...**, then **Commit changes** again.

> **What is it for?** GitHub tries to be clever with files in certain
> circumstances. This empty file politely tells it not to. It costs nothing and
> prevents a confusing problem later.

---

# Step 5 — Switch the website on

Your files are on GitHub now, but they are not a website yet. One switch to go.

1. On your repository page, look along the row of options near the top —
   *Code, Issues, Pull requests…* and so on. Click **Settings**.

   > Cannot see it? Your window may be too narrow. Look for a **…** button at the
   > end of that row and click it — **Settings** will be inside.

2. A list of options appears down the left-hand side. Scroll down that list to
   the heading **Code and automation**, and click **Pages** underneath it.

   > On a narrow window, this list sits *above* the main content instead of to
   > the left. If you cannot see it on the left, scroll down.

3. You will see a section called **Build and deployment**, and under it a
   heading called **Source**.

   Click the dropdown under **Source** and choose **Deploy from a branch**.

4. Underneath, a new dropdown appears showing **None**.

   Click it and choose **main**.

5. Next to that is a second dropdown showing **/ (root)**.

   **Leave it exactly as it is.**

6. Click **Save**.

✅ **You are done with this step when:** the page reloads and no longer says
"None".

---

# Step 6 — Visit your website

**Nothing will happen straight away.** GitHub needs to build your site.

1. **Wait 10 minutes.** Genuinely — go and do something else.

2. Come back to the **Settings → Pages** screen and refresh it (press **F5**).

   Near the top you should now see a section headed **GitHub Pages** with a
   **Visit site** button. Click it. That is the easiest way in — no typing.

3. If you would rather type it, the address is:

   ```
   https://YOUR-USERNAME.github.io/mtg-ff-tracker/
   ```

   Replace `YOUR-USERNAME` with the username you chose in Step 1. All lowercase.
   Do not forget the `/` at the end.

4. If you see a page saying **404** — that is normal at first. Wait another five
   minutes and refresh.

5. When it loads, you will see the tracker with all its card pictures. 🎉

6. **Bookmark it.** Press **Ctrl + D**.

---

## What happens next

The first time it opens, the tracker will ask you where to save your collection.

That is the next guide: **[SETUP.md](SETUP.md), Part 2** — creating your Google
Sheet. Until you do that, you can look around and try things, but anything you
tick will only be saved on this one computer.

---

# If something went wrong

### The website shows "404" and it has been more than an hour

Work through these:

1. **Is your email confirmed?** Go to <https://github.com/settings/emails> and
   check. This is the most common cause by far. Confirm it, then wait 10 minutes.
2. **Is `index.html` in the main list of files?** It must be sitting on its own in
   the file list, not inside a folder. See the next problem if it is.
3. **Check the address.** All lowercase, with `/` at the end.
4. **Check Step 5 stuck.** Go back to Settings → Pages and confirm it still says
   **Deploy from a branch**, **main**, and **/ (root)**.

### I dragged the MTG folder instead of the files inside it

You will know because your file list shows a single folder called `MTG` instead
of lots of files.

The simplest fix is to start over — it takes two minutes:

1. On your repository page, click **Settings**.
2. Scroll all the way to the bottom, to the red section called **Danger Zone**.
3. Click **Delete this repository** and follow the prompts. It will ask you to
   type the repository name to confirm.
4. Go back to **Step 2** and try again, this time opening the MTG folder first
   so you are selecting the files *inside* it.

### The drag and drop did not work

Some browsers will not accept dragged folders. Do it in two passes instead:

**Pass 1 — the loose files:**
1. **Add file** → **Upload files** → click **choose your files**
2. Select just the files (not the folders): `index.html`, `style.css`, `app.js`,
   `cards_data.js`, `manifest.webmanifest`, `sw.js`, and any others you see
3. Click **Commit changes**

**Pass 2 — the icons folder:**
1. **Add file** → **Upload files**
2. Drag *just* the `icons` folder into the box
3. Click **Commit changes**

Those are the parts the website genuinely needs. The other folders (`tools`,
`Old`, `.github`) are optional extras — the tracker works fine without them.

### The page loads but looks like plain text with no colours

Some files did not make it across. Go back to your repository and check that
`style.css` and `app.js` are both in the list. If either is missing, upload it
again with **Add file** → **Upload files**.

### The page loads but there are no card pictures

`cards_data.js` did not upload — it is the biggest file, at about 2 MB, so it is
the most likely one to have been missed. Upload it again on its own.

### I accidentally made the repository Private

Turning the repository private switches the website off. **Turning it public
again does not switch the website back on** — nothing warns you about this, and
the site keeps showing 404 until you redo one step by hand.

1. Repository page → **Settings**
2. Scroll to the bottom, to the **Danger Zone**
3. Find **Change repository visibility**, click **Change visibility**, and switch
   it to public
4. Now redo **Step 5**. Under **Source** it will say **None** again — set it back
   to **Deploy from a branch**, **main**, **/ (root)**, and click **Save**
5. Wait 10 minutes, then check the site again

While you are there, click the **Actions** tab. If it offers a green button
saying **I understand my workflows, go ahead and enable them**, click it — going
private and back also pauses the weekly price refresh.

> **Why does this happen?** Free GitHub accounts can only publish websites from
> *public* repositories. Going private removes that permission, so GitHub
> switches the website off rather than leaving it broken. It does not remember
> the setting when the permission comes back.

### My username has capital letters in it

That is fine. Just type it all in lowercase in the web address — GitHub does not
mind.

### I want to change something later

Everything on GitHub can be edited in the browser. Click any file, then click the
pencil icon in its top-right corner. Change what you like, scroll down, and click
**Commit changes**.

Give it 10 minutes and your live website updates by itself.
