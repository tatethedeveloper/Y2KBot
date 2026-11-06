# Buddy gallery

Ready-made buddies. In Y2Kbot open **My Agents → Buddy Gallery…** and click **Add** on the ones you want, or import any of these files with **My Agents → Import a Buddy…**.

A buddy file holds a buddy's screen name, profile, instructions, icon and powers. It never contains keys: gallery buddies use your default model unless you pick another in Buddy Setup.

## Adding your own

1. Make the buddy in Y2Kbot and get it working the way you like.
2. **My Agents → Export Buddy…** (without memory) and save it here.
3. Add a `gallery` block at the top so it shows up nicely:

```json
"gallery": { "title": "Short job title", "blurb": "One sentence on what it's good at.", "category": "Coding" }
```

4. Open a pull request. Keep instructions clear and safe, and don't include personal details.
