//! Share link insights for the owner: who opened a link and how much of it
//! they watched, the comments viewers left, and the per-link switches that
//! turn insights, comments and reactions on or off.
//!
//! Viewers never use the app: tracking, posting a comment and reacting all
//! happen on the console's share page. This is the owner's side.
//!
//! Server routes (all on the HCFS server, owner bearer):
//!
//! - `GET /v1/shares/{token}/insights`: the numbers. A free plan gets total
//!   views and unique viewers plus the NAMES of what is locked (`locked`);
//!   the server never computes or sends the locked values. Every locked
//!   metric leaves here as [`Gated::Locked`], which carries no value at all,
//!   so the screen can only draw a placeholder for it.
//! - `GET /v1/shares/{token}/comments?after=`, `DELETE .../comments/{id}`:
//!   comments are end-to-end encrypted ([`super::comment_crypto`]); they are
//!   opened here with the link's key, recovered from the keystore or the
//!   owner wrap.
//! - `POST` / `DELETE .../comments/{id}/block`: block or unblock the author
//!   of a comment on this link. The server keys the block on the author
//!   without ever naming them, and lists no block state, so whether someone
//!   is blocked is only known to the sheet that just did it.
//! - `GET /v1/shares/{token}/reactions`: the totals per emoji.
//! - `GET /v1/shares/{token}/meta`: the link's switches as they stand
//!   (`settings`), for the sheet's Link settings.
//! - `PATCH /v1/shares/{token}/settings`: `{insights, comments, reactions}`,
//!   partial. A new link's defaults are sent right after it is minted, in the
//!   background and best-effort ([`spawn_apply`]), the way a chat preview is
//!   (`shares::preview`): a failure never fails or slows the share.
//!
//! Every route is gated on its `/v1/capabilities` flag (`share_insights`,
//! `share_comments`); a server without them is sent nothing and the app
//! shows nothing new.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tracing::{debug, info, warn};

use super::SqliteShareKeystore;
use super::capabilities::{ServerCapabilities, fetch_capabilities};
use super::comment_crypto::{self, CommentKey, CommentMention, MentionKind};
use crate::app_state::AppState;
use crate::auth::tokens::get_api_token;
use crate::error::{AppError, Result};
use hcfs_client::client::share::{ShareKeystore, ShareSecret};

/// How long one request may take. These back an open sheet, not a transfer.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// The most comment pages read for one sheet. The server keeps at most 500
/// comments a link, so this is a bound on a misbehaving cursor, not a limit
/// anyone reaches.
const MAX_COMMENT_PAGES: usize = 25;

/// Shown when the server does not have the routes yet. The screens that ask
/// are hidden on such a server, so this only reaches someone who got there
/// some other way.
const INSIGHTS_UNAVAILABLE: &str = "Insights aren't available yet.";
const COMMENTS_UNAVAILABLE: &str = "Comments aren't available yet.";
const LINK_GONE: &str = "This link isn't active any more.";
/// Shown when the server could not be asked which switches it takes, so a
/// link's switches can be neither read nor changed. Never "all off": that
/// would be a guess dressed up as the link's state.
const SETTINGS_UNREACHABLE: &str = "Couldn't reach Hippius to check this link's settings. Try again.";
const COMMENT_GONE: &str = "That comment isn't on this link any more.";

// ─── Insights ──────────────────────────────────────────────────────────────

/// The account's plan, as the insights route reports it. Anything this
/// build does not know reads as free: the most it can do is hide numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InsightsPlan {
    Free,
    Paid,
}

/// A metric the plan may lock. `Locked` carries nothing, so a locked value
/// cannot reach the screen even by mistake: the server does not send it,
/// and if it ever did, it would be dropped here.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", content = "value", rename_all = "camelCase")]
pub enum Gated<T> {
    Locked,
    Shown(T),
}

/// One person who opened the link, as the owner sees them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsViewer {
    /// The random id the share page keeps in the viewer's browser. Not a
    /// person: used to tell rows apart.
    pub viewer_id: String,
    /// The name they chose to show when they commented, decrypted. `None`
    /// for everyone else, who the screen calls "Someone".
    pub name: Option<String>,
    pub visits: u64,
    pub watched_ms: u64,
    /// 0 to 1, `None` for a picture.
    pub completion: Option<f64>,
    /// RFC 3339.
    pub last_viewed_at: Option<String>,
    pub comments: u64,
    pub reactions: u64,
}

/// The owner's Insights for one link.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInsights {
    pub plan: InsightsPlan,
    pub total_views: u64,
    pub unique_viewers: u64,
    /// Mean completion over video visits, 0 to 1. `Shown(None)` when there
    /// is nothing to measure (a picture, or no video visit yet).
    pub completion: Gated<Option<f64>>,
    /// 100 buckets, each the percentage (0 to 100) of video visits that
    /// covered that 1% of the video. `Shown(None)` as for `completion`.
    pub retention: Gated<Option<Vec<f64>>>,
    /// Newest visit first.
    pub viewers: Gated<Vec<InsightsViewer>>,
}

#[derive(Debug, Deserialize)]
struct WireInsights {
    #[serde(default)]
    plan: String,
    #[serde(default)]
    total_views: u64,
    #[serde(default)]
    unique_viewers: u64,
    #[serde(default)]
    completion_rate: Option<f64>,
    #[serde(default)]
    retention: Option<Vec<f64>>,
    #[serde(default)]
    viewers: Option<Vec<WireViewer>>,
    #[serde(default)]
    locked: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct WireViewer {
    #[serde(default)]
    viewer_id: String,
    #[serde(default)]
    visits: u64,
    #[serde(default)]
    watched_ms: u64,
    #[serde(default)]
    completion: Option<f64>,
    #[serde(default)]
    last_viewed_at: Option<String>,
    #[serde(default)]
    comments: u64,
    #[serde(default)]
    reactions: u64,
    #[serde(default)]
    name_ct: Option<String>,
    #[serde(default)]
    name_nonce: Option<String>,
}

fn unit(x: f64) -> f64 {
    if x.is_finite() { x.clamp(0.0, 1.0) } else { 0.0 }
}

fn percent(x: f64) -> f64 {
    if x.is_finite() { x.clamp(0.0, 100.0) } else { 0.0 }
}

/// Parse the insights body and decide what may be shown. `names` opens a
/// viewer's encrypted name; it is only called for a metric that is shown.
///
/// A metric is locked when the server names it in `locked`, and always on a
/// plan that is not paid: whatever arrives for it is dropped.
fn parse_insights(body: &str, mut names: impl FnMut(&str, &str) -> Option<String>) -> Result<ShareInsights> {
    let wire: WireInsights = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("insights parse failed: {e}")))?;
    let plan = if wire.plan == "paid" { InsightsPlan::Paid } else { InsightsPlan::Free };
    let locked: HashSet<&str> = wire.locked.iter().map(String::as_str).collect();
    let is_locked = |metric: &str| plan != InsightsPlan::Paid || locked.contains(metric);

    let completion = if is_locked("completion_rate") {
        Gated::Locked
    } else {
        Gated::Shown(wire.completion_rate.map(unit))
    };
    let retention = if is_locked("retention") {
        Gated::Locked
    } else {
        Gated::Shown(wire.retention.filter(|r| !r.is_empty()).map(|r| r.into_iter().map(percent).collect()))
    };
    let viewers = if is_locked("viewers") {
        Gated::Locked
    } else {
        let mut rows: Vec<InsightsViewer> = wire
            .viewers
            .unwrap_or_default()
            .into_iter()
            .map(|v| {
                let name = match (v.name_ct.as_deref(), v.name_nonce.as_deref()) {
                    (Some(ct), Some(nonce)) => names(nonce, ct).map(readable_name),
                    _ => None,
                };
                InsightsViewer {
                    viewer_id: v.viewer_id,
                    name,
                    visits: v.visits,
                    watched_ms: v.watched_ms,
                    completion: v.completion.map(unit),
                    last_viewed_at: v.last_viewed_at,
                    comments: v.comments,
                    reactions: v.reactions,
                }
            })
            .collect();
        // RFC 3339 in UTC sorts as text; a row with no time goes last.
        rows.sort_by(|a, b| b.last_viewed_at.cmp(&a.last_viewed_at));
        Gated::Shown(rows)
    };

    Ok(ShareInsights {
        plan,
        total_views: wire.total_views,
        unique_viewers: wire.unique_viewers,
        completion,
        retention,
        viewers,
    })
}

/// The shortest address an access-key account's generated name can hold.
const GENERATED_NAME_MIN_ADDRESS: usize = 40;
/// The longest; an SS58 address is 47 or 48 characters.
const GENERATED_NAME_MAX_ADDRESS: usize = 64;

/// A viewer's or commenter's name as the owner reads it. An account signed in
/// with an access key has no name of its own, so the share page signs its
/// comments with the account's generated username, `user_` and the whole
/// wallet address in lower case. That reads as noise and puts the full
/// address on screen, so it is shown as the address shortened to its first 6
/// and last 4 characters (`5dsqam…sk63`). A name the person chose is kept as
/// it is.
fn readable_name(name: String) -> String {
    let Some(address) = name.strip_prefix("user_") else {
        return name;
    };
    let generated =
        (GENERATED_NAME_MIN_ADDRESS..=GENERATED_NAME_MAX_ADDRESS).contains(&address.len()) && address.bytes().all(|b| b.is_ascii_alphanumeric());
    if !generated {
        return name;
    }
    // ASCII only (checked above), so byte offsets are character offsets.
    format!("{}\u{2026}{}", &address[..6], &address[address.len() - 4..])
}

// ─── Comments ──────────────────────────────────────────────────────────────

/// One comment, opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareComment {
    pub id: String,
    /// `None` when this comment could not be read (see `ShareComments`).
    pub text: Option<String>,
    /// The name the viewer chose to show. `None` for an anonymous comment
    /// and for one posted without a name; the screen says "Someone".
    pub name: Option<String>,
    /// The moment in the video it is about, in milliseconds.
    pub at_ms: Option<u64>,
    /// RFC 3339.
    pub created_at: String,
    /// The people it @mentions, in the order their `@Name` appears in the
    /// text. Empty when it mentions nobody or could not be read.
    pub mentions: Vec<ShareCommentMention>,
    /// It mentions the owner reading it (never true on the owner's own).
    pub mentions_you: bool,
}

/// Someone a comment @mentions, as the owner's panel draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareCommentMention {
    pub kind: MentionKind,
    /// The name after the `@`, as the text holds it: what the panel looks
    /// for to highlight it.
    pub name: String,
    /// How it reads: a generated access-key name shortened, like an author
    /// ([`readable_name`]).
    pub label: String,
    /// It is the owner: a mention of the owner, or of a comment the owner wrote.
    pub you: bool,
}

/// A mention as the owner reads it. `mine` holds the ids of the owner's own
/// comments on the link, which is how a mention of the owner as a commenter
/// is known.
fn owner_mention(m: CommentMention, mine: &HashSet<String>) -> ShareCommentMention {
    let you = match m.kind {
        MentionKind::Owner => true,
        MentionKind::Commenter => m.comment.as_ref().is_some_and(|id| mine.contains(id)),
    };
    ShareCommentMention {
        kind: m.kind,
        label: readable_name(m.name.clone()),
        name: m.name,
        you,
    }
}

/// Whether `text` holds `@name`, the way a mention is written.
fn mentioned_in(text: &str, name: &str) -> bool {
    !name.is_empty() && text.contains(&format!("@{name}"))
}

/// A link's comments, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareComments {
    pub comments: Vec<ShareComment>,
    /// Why none of them can be read on this computer, in a sentence to show;
    /// `None` when they can.
    pub unreadable: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireComment {
    id: serde_json::Value,
    #[serde(default)]
    ciphertext: String,
    #[serde(default)]
    nonce: String,
    #[serde(default)]
    at_ms: Option<u64>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    anonymous: bool,
    /// Written by the signed-in account, here the owner.
    #[serde(default)]
    mine: bool,
}

impl WireComment {
    /// The server's id as a string, whether it sent a number or a string.
    fn id(&self) -> String {
        match &self.id {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }
}

/// A comments page: the contract allows a bare list or a list with a
/// cursor for the next page.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum WireCommentsPage {
    Paged {
        #[serde(alias = "items")]
        comments: Vec<WireComment>,
        #[serde(default, alias = "next_after", alias = "next_cursor")]
        next: Option<serde_json::Value>,
    },
    Bare(Vec<WireComment>),
}

impl WireCommentsPage {
    fn into_parts(self) -> (Vec<WireComment>, Option<String>) {
        match self {
            Self::Bare(items) => (items, None),
            Self::Paged { comments, next } => {
                let next = next.and_then(|v| match v {
                    serde_json::Value::String(s) if !s.is_empty() => Some(s),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    _ => None,
                });
                (comments, next)
            }
        }
    }
}

/// Why a link's comments cannot be opened here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyUnavailable {
    /// A password link: its key is wrapped by a password nobody stores.
    Password,
    /// The link's key is not on this computer and no owner wrap brought it.
    NotOnDevice,
}

impl KeyUnavailable {
    fn sentence(self) -> &'static str {
        match self {
            Self::Password => "This link has a password, so its comments can only be read on the link's page.",
            Self::NotOnDevice => "Comments can't be read on this computer because the link's key isn't here.",
        }
    }
}

/// Open each comment with `key`, or explain why none can be.
fn open_comments(token: &str, items: Vec<WireComment>, key: std::result::Result<&CommentKey, KeyUnavailable>) -> ShareComments {
    let mine: HashSet<String> = items.iter().filter(|c| c.mine).map(WireComment::id).collect();
    let comments = items
        .into_iter()
        .map(|c| {
            let opened = key
                .ok()
                .and_then(|k| comment_crypto::open_comment(k, token, &c.nonce, &c.ciphertext).ok());
            let (text, name, mentions) = match opened {
                // An anonymous comment never shows a name, whatever its
                // ciphertext carries.
                Some(p) => {
                    // A mention counts only where its `@Name` is in the text:
                    // the list is sealed with the comment by whoever wrote
                    // it, so it could claim "mentioned you" over any text.
                    let mentions = p
                        .mentions
                        .into_iter()
                        .filter(|m| mentioned_in(&p.text, &m.name))
                        .map(|m| owner_mention(m, &mine))
                        .collect::<Vec<_>>();
                    (Some(p.text), if c.anonymous { None } else { p.name.map(readable_name) }, mentions)
                }
                None => (None, None, Vec::new()),
            };
            let mentions_you = !c.mine && mentions.iter().any(|m| m.you);
            ShareComment {
                id: c.id(),
                text,
                name,
                at_ms: c.at_ms,
                created_at: c.created_at,
                mentions,
                mentions_you,
            }
        })
        .collect();
    ShareComments {
        comments,
        unreadable: key.err().map(|why| why.sentence().to_string()),
    }
}

// ─── Reactions ─────────────────────────────────────────────────────────────

/// The emoji a viewer can react with, in the order the share page shows
/// them (the server's `REACTIONS`).
pub const REACTION_EMOJI: [&str; 8] = [
    "\u{1F44D}",
    "\u{2764}\u{FE0F}",
    "\u{1F602}",
    "\u{1F62E}",
    "\u{1F389}",
    "\u{1F44F}",
    "\u{1F525}",
    "\u{1F64C}",
];

/// How many people chose one emoji.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionCount {
    pub emoji: String,
    pub count: u64,
}

/// A link's reaction totals, as the owner sees them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareReactions {
    /// Only the emoji somebody chose, in the share page's order.
    pub counts: Vec<ReactionCount>,
    pub total: u64,
}

/// `{counts: {emoji: n}, mine: [..]}` to the emoji people chose, in the
/// share page's order. A heart with or without its variation selector is
/// one heart; an emoji the share page does not offer is left out, as the
/// console leaves it out.
fn parse_reactions(body: &str) -> Result<ShareReactions> {
    #[derive(Deserialize)]
    struct Wire {
        #[serde(default)]
        counts: HashMap<String, u64>,
    }
    let wire: Wire = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("reactions parse failed: {e}")))?;
    let bare = |e: &str| e.replace('\u{FE0F}', "");
    let counts: Vec<ReactionCount> = REACTION_EMOJI
        .iter()
        .filter_map(|emoji| {
            let count: u64 = wire.counts.iter().filter(|(k, _)| bare(k) == bare(emoji)).map(|(_, n)| *n).sum();
            (count > 0).then(|| ReactionCount {
                emoji: (*emoji).to_string(),
                count,
            })
        })
        .collect();
    let total = counts.iter().map(|c| c.count).sum();
    Ok(ShareReactions { counts, total })
}

// ─── Per-link switches ─────────────────────────────────────────────────────

/// A link's three switches.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSettings {
    pub insights: bool,
    pub comments: bool,
    pub reactions: bool,
}

impl LinkSettings {
    /// All three on (`true`) or off.
    #[must_use]
    pub const fn all(on: bool) -> Self {
        Self {
            insights: on,
            comments: on,
            reactions: on,
        }
    }

    const fn any(self) -> bool {
        self.insights || self.comments || self.reactions
    }
}

/// Which switches a server takes: Insights with `share_insights`, Comments
/// and Reactions with `share_comments` as well (the settings route is
/// phase 1's; the features behind the last two are phase 2's).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferedSwitches {
    pub insights: bool,
    pub comments: bool,
    pub reactions: bool,
}

impl OfferedSwitches {
    #[must_use]
    pub fn from_caps(caps: &ServerCapabilities) -> Self {
        let comments = caps.share_insights && caps.share_comments;
        Self {
            insights: caps.share_insights,
            comments,
            reactions: comments,
        }
    }
}

/// The body of `PATCH /settings`: only the keys this server takes. Also what
/// the app sends to change a link's switches: only the switch the owner
/// flipped, so a change can never put back another switch it did not touch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insights: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comments: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reactions: Option<bool>,
}

impl SettingsPatch {
    const fn is_empty(self) -> bool {
        self.insights.is_none() && self.comments.is_none() && self.reactions.is_none()
    }

    /// The switches this patch turns (or keeps) on; one it leaves out or
    /// turns off reads as off.
    const fn asked_on(self) -> LinkSettings {
        LinkSettings {
            insights: matches!(self.insights, Some(true)),
            comments: matches!(self.comments, Some(true)),
            reactions: matches!(self.reactions, Some(true)),
        }
    }
}

/// The PATCH for `wanted` on a server offering `offered`, or `None` when
/// there is nothing to send. `new_link`: a link just minted starts with all
/// three off on the server, so an all-off choice for one needs no request.
#[must_use]
pub fn patch_for(wanted: LinkSettings, offered: OfferedSwitches, new_link: bool) -> Option<SettingsPatch> {
    if new_link && !wanted.any() {
        return None;
    }
    let patch = SettingsPatch {
        insights: offered.insights.then_some(wanted.insights),
        comments: offered.comments.then_some(wanted.comments),
        reactions: offered.reactions.then_some(wanted.reactions),
    };
    (!patch.is_empty()).then_some(patch)
}

/// `change` cut to the switches a server offering `offered` takes, or `None`
/// when nothing is left to send. Unlike [`patch_for`], a switch the change
/// leaves out stays out: the server keeps it as it stands.
#[must_use]
pub fn change_for(change: SettingsPatch, offered: OfferedSwitches) -> Option<SettingsPatch> {
    let patch = SettingsPatch {
        insights: change.insights.filter(|_| offered.insights),
        comments: change.comments.filter(|_| offered.comments),
        reactions: change.reactions.filter(|_| offered.reactions),
    };
    (!patch.is_empty()).then_some(patch)
}

/// Where the share dialog's switches start for a file, and which it shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSettingsDefault {
    pub offered: OfferedSwitches,
    pub on: LinkSettings,
    /// Whether this account's plan includes the switches
    /// ([`switches_in_plan`]): `false` on the free plan, where turning any of
    /// them on shows the upgrade prompt instead; `None` when the plan could
    /// not be read, which locks nothing but starts all three off.
    pub switches_in_plan: Option<bool>,
}

/// The switches for a file: offered for a file (never a folder, whose links
/// have no insights yet) on a server that takes them; on for a screenshot or
/// recording when Settings' "Track views, comments and reactions" is on, off
/// for every other file. They start on only on a plan known to include them
/// ([`within_plan`]).
#[must_use]
pub fn default_for(
    is_folder: bool,
    is_capture: bool,
    captures_default: bool,
    caps: &ServerCapabilities,
    switches_in_plan: Option<bool>,
) -> LinkSettingsDefault {
    let offered = if is_folder {
        OfferedSwitches::default()
    } else {
        OfferedSwitches::from_caps(caps)
    };
    let on = is_capture && captures_default;
    LinkSettingsDefault {
        offered,
        on: within_plan(
            LinkSettings {
                insights: offered.insights && on,
                comments: offered.comments && on,
                reactions: offered.reactions && on,
            },
            switches_in_plan,
        ),
        switches_in_plan,
    }
}

// ─── The plan rule ─────────────────────────────────────────────────────────
//
// A link's three switches, Insights (counting views, watch time, and the
// owner's numbers), Comments and Reactions, come with every paid Drive plan
// and not with the free plan.
//
// This is the one place the rule lives. A new link gets them only on a plan
// known to include them, so a plan that cannot be read starts all three off
// and never holds the share up. Links that already have a switch on keep it
// whatever the plan: nothing here turns a switch off, and turning one off
// always works.

/// What the plan says about the switches, from the same plan read that
/// decides a capture's watermark and recording limit (`capture::allowance`):
/// `true` on a paid Drive plan, `false` on the free plan, `None` when the
/// read could not tell.
#[must_use]
pub fn switches_in_plan(tier: Option<crate::capture::allowance::RecordingTier>) -> Option<bool> {
    tier.map(|tier| tier == crate::capture::allowance::RecordingTier::Paid)
}

/// `wanted` as this plan allows it on a new link: as asked on a plan known to
/// include the switches, all off otherwise.
#[must_use]
pub const fn within_plan(wanted: LinkSettings, switches_in_plan: Option<bool>) -> LinkSettings {
    let in_plan = matches!(switches_in_plan, Some(true));
    LinkSettings {
        insights: wanted.insights && in_plan,
        comments: wanted.comments && in_plan,
        reactions: wanted.reactions && in_plan,
    }
}

/// Whether turning a link's switches to `wanted` is refused on this plan
/// (`was` is how they stood): only switching one ON from off on a plan known
/// to be free. Turning one off, leaving it on, or a plan that could not be
/// read is never refused.
#[must_use]
pub const fn refuses_switching_on(wanted: LinkSettings, was: LinkSettings, switches_in_plan: Option<bool>) -> bool {
    let turned_on = (wanted.insights && !was.insights) || (wanted.comments && !was.comments) || (wanted.reactions && !was.reactions);
    turned_on && matches!(switches_in_plan, Some(false))
}

/// The refusal for turning a switch on from the free plan, in the upgrade
/// prompt's words. The app shows that prompt before asking, so only a stale
/// screen reaches this.
pub const SWITCHES_NOT_IN_PLAN: &str = "Insights, comments and reactions are available on paid Drive plans.";

/// How long the plan read may take for the share dialog or a new link. A
/// read that takes longer counts as "could not tell".
const PLAN_WITHIN: Duration = Duration::from_secs(5);

/// [`switches_in_plan`] for the signed-in account, read fresh. `account_id`
/// must still be the session's account; anything else, a failed read or a
/// slow one is `None`.
pub(crate) async fn read_switches_in_plan(state: &AppState, account_id: &str) -> Option<bool> {
    let account = state.current_session_account().ok().filter(|a| a.as_str() == account_id)?;
    match tokio::time::timeout(PLAN_WITHIN, crate::billing::storage_overview::fetch_plan_reads(state, &account)).await {
        Ok(Ok(reads)) => switches_in_plan(crate::capture::allowance::tier_from_reads(&reads)),
        Ok(Err(e)) => {
            debug!(error = %e, "share insights: the plan could not be read");
            None
        }
        Err(_) => {
            debug!("share insights: the plan read took too long");
            None
        }
    }
}

/// A link's switches as `/meta` reports them (`settings`). A server that
/// predates them omits the field, which reads as all off, the way a new
/// link starts.
fn parse_meta_settings(body: &str) -> Result<LinkSettings> {
    #[derive(Deserialize)]
    struct Wire {
        #[serde(default)]
        settings: Option<LinkSettings>,
    }
    let wire: Wire = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("share meta parse failed: {e}")))?;
    Ok(wire.settings.unwrap_or_default())
}

/// What a capture's automatic link gets: everything on when Settings says
/// so, nothing otherwise.
#[must_use]
pub const fn for_capture(captures_default: bool) -> LinkSettings {
    LinkSettings::all(captures_default)
}

// ─── Notification preferences ──────────────────────────────────────────────

/// How often the summary email comes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Digest {
    Off,
    Daily,
    Weekly,
}

/// The share-link emails this account gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    /// "Your recording is getting views", once per link.
    pub first_views: bool,
    /// New comments, batched, counted (never quoted: they are encrypted).
    pub comments: bool,
    pub digest: Digest,
}

impl Default for NotificationPreferences {
    /// The server's defaults: first views and comments on, a weekly summary.
    fn default() -> Self {
        Self {
            first_views: true,
            comments: true,
            digest: Digest::Weekly,
        }
    }
}

/// The wire shape (snake_case), read leniently: a missing field is the
/// server's default and an unknown digest is the default digest.
fn parse_preferences(body: &str) -> Result<NotificationPreferences> {
    #[derive(Deserialize)]
    struct Wire {
        first_views: Option<bool>,
        comments: Option<bool>,
        digest: Option<String>,
    }
    let wire: Wire = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("notification preferences parse failed: {e}")))?;
    let d = NotificationPreferences::default();
    Ok(NotificationPreferences {
        first_views: wire.first_views.unwrap_or(d.first_views),
        comments: wire.comments.unwrap_or(d.comments),
        digest: match wire.digest.as_deref() {
            Some("off") => Digest::Off,
            Some("daily") => Digest::Daily,
            Some("weekly") => Digest::Weekly,
            _ => d.digest,
        },
    })
}

fn preferences_body(prefs: NotificationPreferences) -> serde_json::Value {
    serde_json::json!({
        "first_views": prefs.first_views,
        "comments": prefs.comments,
        "digest": prefs.digest,
    })
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

/// The server's base URL and the owner's bearer, resolved once per call.
#[derive(Debug, Clone)]
pub(crate) struct Api {
    base: String,
    bearer: String,
}

impl Api {
    #[cfg(test)]
    fn new(base: &str, bearer: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            bearer: bearer.to_string(),
        }
    }

    async fn for_account(state: &AppState, account_id: &str) -> Result<Self> {
        let pool = state.pool()?;
        let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;
        let base = crate::sync::region::resolve_base_url(&server_url).trim_end_matches('/').to_string();
        let bearer = get_api_token(pool, account_id)
            .await?
            .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;
        Ok(Self { base, bearer })
    }

    fn share_url(&self, token: &str, rest: &str) -> Result<String> {
        Ok(format!("{}/v1/shares/{}{rest}", self.base, path_segment(token)?))
    }
}

/// `s` percent-encoded for a query value (RFC 3986 unreserved characters
/// kept). The cursor is the server's own, so it is passed back exactly.
fn query_value(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// `s` as one URL path segment. Share tokens and comment ids are URL-safe
/// base64 or UUIDs; anything else is refused before a request is built, so
/// an id can never reach another route.
fn path_segment(s: &str) -> Result<&str> {
    let ok = !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(s)
    } else {
        Err(AppError::Validation("That link or comment isn't valid.".into()))
    }
}

/// The body of a 2xx, or the error for anything else. A 404 is the link
/// that is no longer live (revoked or expired), worded for the sheet.
async fn read_ok(resp: reqwest::Response) -> Result<String> {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(body);
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::NotFound(LINK_GONE.into()));
    }
    Err(AppError::Api {
        status: status.as_u16(),
        body,
    })
}

/// A request that never got an answer, worded without its URL: reqwest's
/// `Display` appends the request URL, and every route here carries the
/// link's token in its path, which opens the link's unencrypted preview.
/// This text reaches the Insights panel, screenshots of it and the logs.
fn transport(what: &str, e: reqwest::Error) -> AppError {
    let reason = if e.is_timeout() {
        "Hippius took too long to answer".to_string()
    } else if e.is_connect() {
        "couldn't reach Hippius".to_string()
    } else {
        e.without_url().to_string()
    };
    AppError::Hcfs(format!("{what} failed: {reason}"))
}

async fn get_insights_body(http: &reqwest::Client, api: &Api, token: &str) -> Result<String> {
    let resp = http
        .get(api.share_url(token, "/insights")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("insights", e))?;
    read_ok(resp).await
}

/// Every comment on the link, following the server's cursor.
async fn get_all_comments(http: &reqwest::Client, api: &Api, token: &str) -> Result<Vec<WireComment>> {
    let mut all = Vec::new();
    let mut seen = HashSet::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_COMMENT_PAGES {
        let mut url = api.share_url(token, "/comments")?;
        if let Some(cursor) = &after {
            url = format!("{url}?after={}", query_value(cursor));
        }
        let req = http.get(url).bearer_auth(&api.bearer).timeout(REQUEST_TIMEOUT);
        let body = read_ok(req.send().await.map_err(|e| transport("comments", e))?).await?;
        let page: WireCommentsPage = serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("comments parse failed: {e}")))?;
        let (items, next) = page.into_parts();
        let mut fresh = 0usize;
        for item in items {
            if seen.insert(item.id()) {
                all.push(item);
                fresh += 1;
            }
        }
        // A page with nothing new ends it too, so a cursor that does not
        // move cannot loop.
        match next {
            Some(cursor) if fresh > 0 => after = Some(cursor),
            _ => break,
        }
    }
    Ok(all)
}

async fn delete_comment_at(http: &reqwest::Client, api: &Api, token: &str, comment_id: &str) -> Result<()> {
    let resp = http
        .delete(api.share_url(token, &format!("/comments/{}", path_segment(comment_id)?))?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("comment delete", e))?;
    // Already gone is what the owner asked for.
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    read_ok(resp).await.map(|_| ())
}

/// Block (`true`) or unblock the author of a comment on the owner's link.
/// The server never says who the author is; it keys the block on them, so
/// it outlasts the comment it was made through.
async fn set_comment_author_blocked(http: &reqwest::Client, api: &Api, token: &str, comment_id: &str, blocked: bool) -> Result<()> {
    let url = api.share_url(token, &format!("/comments/{}/block", path_segment(comment_id)?))?;
    let req = if blocked { http.post(url) } else { http.delete(url) };
    let resp = req
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("comment block", e))?;
    // The bodiless 404 covers a link that is gone and a comment that is no
    // longer there; the sheet re-reads the list either way, so say the one
    // the owner can act on.
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::NotFound(COMMENT_GONE.into()));
    }
    read_ok(resp).await.map(|_| ())
}

async fn get_reactions_body(http: &reqwest::Client, api: &Api, token: &str) -> Result<String> {
    let resp = http
        .get(api.share_url(token, "/reactions")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("reactions", e))?;
    read_ok(resp).await
}

/// The link's anonymous `/meta`, which carries its switches. No bearer: the
/// route is the recipient's, and it is the one that reports them per link.
async fn get_meta_body(http: &reqwest::Client, api: &Api, token: &str) -> Result<String> {
    let resp = http
        .get(api.share_url(token, "/meta")?)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("share meta", e))?;
    read_ok(resp).await
}

async fn patch_settings(http: &reqwest::Client, api: &Api, token: &str, patch: &SettingsPatch) -> Result<()> {
    let resp = http
        .patch(api.share_url(token, "/settings")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .json(patch)
        .send()
        .await
        .map_err(|e| transport("share settings", e))?;
    read_ok(resp).await.map(|_| ())
}

async fn get_preferences(http: &reqwest::Client, api: &Api) -> Result<NotificationPreferences> {
    let resp = http
        .get(format!("{}/v1/notification-preferences", api.base))
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("notification preferences", e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Api {
            status: status.as_u16(),
            body,
        });
    }
    parse_preferences(&body)
}

async fn put_preferences(http: &reqwest::Client, api: &Api, prefs: NotificationPreferences) -> Result<()> {
    let resp = http
        .put(format!("{}/v1/notification-preferences", api.base))
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .json(&preferences_body(prefs))
        .send()
        .await
        .map_err(|e| transport("notification preferences", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Api {
            status: status.as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    Ok(())
}

// ─── The link's key ────────────────────────────────────────────────────────

/// The comment key for `token`: from the share key this device holds, or the
/// one its owner wrap brings back (the same hydration Shared Links runs).
async fn comment_key_for(state: &AppState, account_id: &str, token: &str) -> std::result::Result<CommentKey, KeyUnavailable> {
    let Ok(pool) = state.pool() else {
        return Err(KeyUnavailable::NotOnDevice);
    };
    let keystore = SqliteShareKeystore::new(pool.clone());
    let mut keys: HashMap<String, ShareSecret> = HashMap::new();
    if let Ok(Some(secret)) = keystore.get(token) {
        keys.insert(token.to_string(), secret);
    } else {
        super::owner_wrap::sync_file_wraps(state, account_id, &keystore, &mut keys, &[token]).await;
    }
    match keys.remove(token) {
        Some(ShareSecret::Public(share_key)) => Ok(CommentKey::derive(&share_key)),
        Some(ShareSecret::Private(_)) => Err(KeyUnavailable::Password),
        // A folder link's secret is not a file link's key and opens no
        // comments; a file token never holds one, so this is a stray row.
        Some(ShareSecret::FolderLink(_) | ShareSecret::FolderLinkPrivate(_)) | None => Err(KeyUnavailable::NotOnDevice),
    }
}

/// The server's capabilities for reading or changing a link's switches: a
/// failed read is an error the owner sees, never a server without switches.
async fn capabilities_checked(state: &AppState, account_id: &str) -> Result<ServerCapabilities> {
    fetch_capabilities(state, account_id).await.map_err(|e| {
        debug!(error = %e, "share settings: capabilities unavailable");
        AppError::Validation(SETTINGS_UNREACHABLE.into())
    })
}

async fn capabilities_or_none(state: &AppState, account_id: &str) -> ServerCapabilities {
    match fetch_capabilities(state, account_id).await {
        Ok(caps) => caps,
        Err(e) => {
            debug!(error = %e, "share insights: capabilities unavailable");
            ServerCapabilities::default()
        }
    }
}

// ─── After a mint ──────────────────────────────────────────────────────────

/// New links whose switches are still on their way to the server
/// ([`spawn_apply`]), by token. The owner can open a new link's Insights and
/// flip a switch before that request lands; landing after the owner's change,
/// it would put back what they just turned off. Reading or changing a link's
/// switches waits for it first ([`after_mint_switches_sent`]).
static SENDING_AFTER_MINT: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The longest a read or a change waits for a new link's switches. Sending
/// them is itself bounded (the plan read, the capabilities read and one
/// request), so this only guards against a send that never ends.
const AFTER_MINT_WAIT: Duration = Duration::from_secs(45);

/// A new link's switches being sent: registered on creation, released (and
/// anyone waiting on it let through) when dropped.
struct SendingSwitches {
    token: String,
    lock: Arc<tokio::sync::Mutex<()>>,
    _held: tokio::sync::OwnedMutexGuard<()>,
}

impl SendingSwitches {
    fn begin(token: &str) -> Self {
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        let held = Arc::clone(&lock).try_lock_owned().expect("a new lock is free");
        SENDING_AFTER_MINT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(token.to_string(), Arc::clone(&lock));
        Self {
            token: token.to_string(),
            lock,
            _held: held,
        }
    }
}

impl Drop for SendingSwitches {
    fn drop(&mut self) {
        let mut sending = SENDING_AFTER_MINT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // Only this send's entry: a later mint of the same token (never
        // expected, tokens are random) keeps its own.
        if sending.get(&self.token).is_some_and(|l| Arc::ptr_eq(l, &self.lock)) {
            sending.remove(&self.token);
        }
    }
}

/// Wait until `token`'s after-mint switches have been sent, if they are
/// still on their way; at once otherwise.
async fn after_mint_switches_sent(token: &str) {
    let lock = SENDING_AFTER_MINT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(token)
        .cloned();
    if let Some(lock) = lock
        && tokio::time::timeout(AFTER_MINT_WAIT, lock.lock()).await.is_err()
    {
        warn!("share settings: a new link's switches took too long; going ahead");
    }
}

/// What [`apply_after_mint`] did with a new link's switches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AfterMint {
    /// Sent: the link has the switches asked for.
    Sent,
    /// Nothing to send: none asked for, not on this plan, or a server without
    /// switches. The link has all three off, as it should.
    NothingToSend,
    /// Asked for but not sent: the plan or the server could not be asked, or
    /// the request failed. The link has all three off, which is not what the
    /// owner chose, so a caller with someone waiting says so.
    NotSent,
}

/// Send a new link's switches, if the server takes them and any is on.
/// Never fails the share: the link is already live and copied.
pub(crate) async fn apply_after_mint(state: &AppState, account_id: &str, share_token: &str, wanted: LinkSettings) -> AfterMint {
    if !wanted.any() {
        return AfterMint::NothingToSend;
    }
    // Every new link passes here (a capture's own link, the share dialog, a
    // Finder share), so this is where the plan rule holds for all of them.
    let in_plan = read_switches_in_plan(state, account_id).await;
    let wanted = within_plan(wanted, in_plan);
    if !wanted.any() {
        return if in_plan.is_none() {
            warn!("share settings not sent: the plan could not be read (the link itself is fine)");
            AfterMint::NotSent
        } else {
            debug!("share settings skipped: not on this plan");
            AfterMint::NothingToSend
        };
    }
    let caps = match fetch_capabilities(state, account_id).await {
        Ok(caps) => caps,
        Err(e) => {
            warn!(error = %e, "share settings not sent: capabilities unavailable (the link itself is fine)");
            return AfterMint::NotSent;
        }
    };
    let Some(patch) = patch_for(wanted, OfferedSwitches::from_caps(&caps), true) else {
        debug!("share settings skipped: the server does not take them");
        return AfterMint::NothingToSend;
    };
    let api = match Api::for_account(state, account_id).await {
        Ok(api) => api,
        Err(e) => {
            warn!(error = %e, "share settings not sent (the link itself is fine)");
            return AfterMint::NotSent;
        }
    };
    match patch_settings(&state.api_client, &api, share_token, &patch).await {
        Ok(()) => {
            info!("share settings sent");
            AfterMint::Sent
        }
        Err(e) => {
            warn!(error = %e, "share settings not sent (the link itself is fine)");
            AfterMint::NotSent
        }
    }
}

/// [`apply_after_mint`] in the background, so the share returns (and its
/// link is copied) without waiting on it.
pub(crate) fn spawn_apply(app: &tauri::AppHandle, account_id: &str, share_token: &str, wanted: LinkSettings) {
    if !wanted.any() {
        return;
    }
    // Registered before the share returns, so a read or change of the new
    // link's switches can never get in ahead of this send.
    let sending = SendingSwitches::begin(share_token);
    let (app, account_id, share_token) = (app.clone(), account_id.to_string(), share_token.to_string());
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let _ = apply_after_mint(&state, &account_id, &share_token, wanted).await;
        drop(sending);
    });
}

/// The capture default ("Track views, comments and reactions" in Settings,
/// on unless turned off), read from the stored capture options.
pub(crate) async fn captures_default(state: &AppState) -> bool {
    match state.pool() {
        Ok(pool) => crate::capture::bar::load_options(pool).await.map_or(true, |o| o.link_insights),
        Err(_) => true,
    }
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// Which of the new share-link features this account's server has. The
/// capture card, which has no capabilities of its own, asks this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngagementFeatures {
    pub insights: bool,
    pub comments: bool,
    pub notifications: bool,
}

#[tauri::command]
pub async fn share_engagement_features(state: tauri::State<'_, AppState>) -> Result<EngagementFeatures> {
    let account_id = state.current_account_id()?;
    let caps = capabilities_or_none(&state, &account_id).await;
    Ok(EngagementFeatures {
        insights: caps.share_insights,
        comments: caps.share_comments,
        notifications: caps.share_notifications,
    })
}

/// The owner's Insights for a file link.
#[tauri::command]
pub async fn share_get_insights(state: tauri::State<'_, AppState>, share_token: String) -> Result<ShareInsights> {
    let account_id = state.current_account_id()?;
    if !capabilities_or_none(&state, &account_id).await.share_insights {
        return Err(AppError::Validation(INSIGHTS_UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    let body = get_insights_body(&state.api_client, &api, &share_token).await?;
    // A viewer's name is only there when they commented under one, so the
    // key is only looked for when some row needs it.
    let key = if body.contains("\"name_ct\":\"") {
        comment_key_for(&state, &account_id, &share_token).await.ok()
    } else {
        None
    };
    parse_insights(&body, |nonce, ct| {
        key.as_ref()
            .and_then(|k| comment_crypto::open_viewer_name(k, &share_token, nonce, ct).ok().flatten())
    })
}

/// A file link's comments, opened with its key.
#[tauri::command]
pub async fn share_list_comments(state: tauri::State<'_, AppState>, share_token: String) -> Result<ShareComments> {
    let account_id = state.current_account_id()?;
    if !capabilities_or_none(&state, &account_id).await.share_comments {
        return Err(AppError::Validation(COMMENTS_UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    let items = get_all_comments(&state.api_client, &api, &share_token).await?;
    if items.is_empty() {
        return Ok(ShareComments {
            comments: Vec::new(),
            unreadable: None,
        });
    }
    let key = comment_key_for(&state, &account_id, &share_token).await;
    Ok(open_comments(&share_token, items, key.as_ref().map_err(|why| *why)))
}

/// Delete a comment on one of this account's links.
#[tauri::command]
pub async fn share_delete_comment(state: tauri::State<'_, AppState>, share_token: String, comment_id: String) -> Result<()> {
    let account_id = state.current_account_id()?;
    if !capabilities_or_none(&state, &account_id).await.share_comments {
        return Err(AppError::Validation(COMMENTS_UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    delete_comment_at(&state.api_client, &api, &share_token, &comment_id).await
}

/// Block the author of a comment from commenting and reacting on this link.
/// Their comments stay until deleted; the owner never learns who they are.
#[tauri::command]
pub async fn share_block_commenter(state: tauri::State<'_, AppState>, share_token: String, comment_id: String) -> Result<()> {
    set_blocked(&state, &share_token, &comment_id, true).await
}

/// Undo [`share_block_commenter`], through any comment of the same author
/// still on the link.
#[tauri::command]
pub async fn share_unblock_commenter(state: tauri::State<'_, AppState>, share_token: String, comment_id: String) -> Result<()> {
    set_blocked(&state, &share_token, &comment_id, false).await
}

async fn set_blocked(state: &AppState, share_token: &str, comment_id: &str, blocked: bool) -> Result<()> {
    let account_id = state.current_account_id()?;
    if !capabilities_or_none(state, &account_id).await.share_comments {
        return Err(AppError::Validation(COMMENTS_UNAVAILABLE.into()));
    }
    let api = Api::for_account(state, &account_id).await?;
    set_comment_author_blocked(&state.api_client, &api, share_token, comment_id, blocked).await
}

/// A file link's reaction totals. Shown to the owner whatever the link's
/// Reactions switch, and on every plan: they are not a locked insight.
#[tauri::command]
pub async fn share_get_reactions(state: tauri::State<'_, AppState>, share_token: String) -> Result<ShareReactions> {
    let account_id = state.current_account_id()?;
    if !capabilities_or_none(&state, &account_id).await.share_comments {
        return Err(AppError::Validation(COMMENTS_UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    parse_reactions(&get_reactions_body(&state.api_client, &api, &share_token).await?)
}

/// A link's switches as they stand, and which this server takes, for the
/// Insights sheet's Link settings.
#[tauri::command]
pub async fn share_get_link_settings(state: tauri::State<'_, AppState>, share_token: String) -> Result<LinkSettingsDefault> {
    let account_id = state.current_account_id()?;
    // A new link's own switches first, so what is read is what it has.
    after_mint_switches_sent(&share_token).await;
    let offered = OfferedSwitches::from_caps(&capabilities_checked(&state, &account_id).await?);
    if !offered.insights {
        return Err(AppError::Validation(INSIGHTS_UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    let (meta, switches_in_plan) = tokio::join!(
        get_meta_body(&state.api_client, &api, &share_token),
        read_switches_in_plan(&state, &account_id),
    );
    let on = parse_meta_settings(&meta?)?;
    Ok(LinkSettingsDefault {
        offered,
        on,
        switches_in_plan,
    })
}

/// Turn a link's switches on or off (the finished link, the Insights panel's
/// Link settings). `change` carries only the switches the owner flipped, and
/// only those the server takes are sent, so two quick changes can never undo
/// each other. A new link's own switches are sent first.
#[tauri::command]
pub async fn share_set_link_settings(state: tauri::State<'_, AppState>, share_token: String, change: SettingsPatch) -> Result<()> {
    let account_id = state.current_account_id()?;
    after_mint_switches_sent(&share_token).await;
    let caps = capabilities_checked(&state, &account_id).await?;
    let Some(patch) = change_for(change, OfferedSwitches::from_caps(&caps)) else {
        return Err(AppError::Validation(INSIGHTS_UNAVAILABLE.into()));
    };
    let api = Api::for_account(&state, &account_id).await?;
    // A switch asked to be on, on the free plan: allowed only if this link
    // already has it on (an older link keeps what it has), so the link's
    // switches are read only then. Turning switches off never asks.
    let asked_on = patch.asked_on();
    if asked_on.any() && read_switches_in_plan(&state, &account_id).await == Some(false) {
        let was = parse_meta_settings(&get_meta_body(&state.api_client, &api, &share_token).await?)?;
        if refuses_switching_on(asked_on, was, Some(false)) {
            return Err(AppError::Validation(SWITCHES_NOT_IN_PLAN.into()));
        }
    }
    patch_settings(&state.api_client, &api, &share_token, &patch).await
}

/// Where the share dialog's Insights, Comments and Reactions switches start
/// for a file, and which it shows. Same capture rule as the chat preview's
/// switch: a screenshot or recording by its drive or its name.
#[tauri::command]
pub async fn share_link_settings_default(
    state: tauri::State<'_, AppState>,
    folder_label: Option<String>,
    file_name: String,
    is_folder: bool,
) -> Result<LinkSettingsDefault> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    let in_captures_drive = match folder_label {
        Some(label) => crate::capture::destination::own_capture_labels(pool, &account_id)
            .await
            .is_ok_and(|labels| labels.contains(&label)),
        None => false,
    };
    let is_capture = in_captures_drive || super::preview::is_capture_name(&file_name);
    let (caps, switches_in_plan) = tokio::join!(capabilities_or_none(&state, &account_id), read_switches_in_plan(&state, &account_id),);
    Ok(default_for(
        is_folder,
        is_capture,
        captures_default(&state).await,
        &caps,
        switches_in_plan,
    ))
}

/// Whether the signed-in account's plan includes the link switches
/// ([`switches_in_plan`]), for Settings' "Track views, comments and
/// reactions", which shows as a paid feature on the free plan. `None` when
/// the plan could not be read.
#[tauri::command]
pub async fn share_switches_in_plan(state: tauri::State<'_, AppState>) -> Result<Option<bool>> {
    let account_id = state.current_account_id()?;
    Ok(read_switches_in_plan(&state, &account_id).await)
}

/// The share-link emails this account gets.
#[tauri::command]
pub async fn share_get_notification_preferences(state: tauri::State<'_, AppState>) -> Result<NotificationPreferences> {
    let account_id = state.current_account_id()?;
    if !capabilities_or_none(&state, &account_id).await.share_notifications {
        return Err(AppError::Validation("Email updates about your links aren't available yet.".into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    get_preferences(&state.api_client, &api).await
}

/// Save the share-link emails this account gets.
#[tauri::command]
pub async fn share_set_notification_preferences(state: tauri::State<'_, AppState>, preferences: NotificationPreferences) -> Result<()> {
    let account_id = state.current_account_id()?;
    if !capabilities_or_none(&state, &account_id).await.share_notifications {
        return Err(AppError::Validation("Email updates about your links aren't available yet.".into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    put_preferences(&state.api_client, &api, preferences).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const FREE: &str = r#"{"plan":"free","total_views":2,"unique_viewers":1,"locked":["completion_rate","viewers","retention"]}"#;
    const PAID: &str = r#"{
        "plan":"paid","total_views":5,"unique_viewers":3,"completion_rate":0.25,
        "retention":[100,100,98,60],
        "viewers":[
          {"viewer_id":"a","visits":2,"watched_ms":78000,"completion":0.25,"last_viewed_at":"2026-10-12T10:00:00Z","comments":0,"reactions":0,"name_ct":null,"name_nonce":null},
          {"viewer_id":"b","visits":1,"watched_ms":1000,"completion":1.4,"last_viewed_at":"2026-10-13T10:00:00Z","comments":1,"reactions":2,"name_ct":"CT","name_nonce":"NONCE"}
        ],
        "locked":[]}"#;

    fn no_names(_: &str, _: &str) -> Option<String> {
        None
    }

    #[test]
    fn a_free_plan_gets_the_two_numbers_and_everything_else_locked() {
        let i = parse_insights(FREE, no_names).unwrap();
        assert_eq!(i.plan, InsightsPlan::Free);
        assert_eq!((i.total_views, i.unique_viewers), (2, 1));
        assert_eq!(i.completion, Gated::Locked);
        assert_eq!(i.retention, Gated::Locked);
        assert_eq!(i.viewers, Gated::Locked);
    }

    /// The wire form of a locked metric has no value in it, so nothing the
    /// screen does with it can show a real number.
    #[test]
    fn a_locked_metric_crosses_ipc_with_no_value() {
        let json = serde_json::to_value(parse_insights(FREE, no_names).unwrap()).unwrap();
        for key in ["completion", "retention", "viewers"] {
            assert_eq!(json[key], serde_json::json!({ "state": "locked" }), "{key}");
        }
        assert_eq!(json["totalViews"], 2);
        assert_eq!(json["plan"], "free");
    }

    /// Should a server ever send a value it also calls locked, or a free plan
    /// carry one, it is dropped here and never rendered.
    #[test]
    fn values_sent_for_a_locked_metric_are_dropped() {
        let leaky =
            r#"{"plan":"free","total_views":2,"unique_viewers":1,"completion_rate":0.9,"retention":[1,2],"viewers":[{"viewer_id":"x"}],"locked":[]}"#;
        let i = parse_insights(leaky, no_names).unwrap();
        assert_eq!((i.completion, i.retention, i.viewers), (Gated::Locked, Gated::Locked, Gated::Locked));

        let partly = r#"{"plan":"paid","total_views":2,"unique_viewers":1,"completion_rate":0.9,"viewers":[],"locked":["completion_rate"]}"#;
        let i = parse_insights(partly, no_names).unwrap();
        assert_eq!(i.completion, Gated::Locked);
        assert_eq!(i.viewers, Gated::Shown(vec![]));

        let unknown_plan = r#"{"plan":"enterprise","total_views":1,"unique_viewers":1,"completion_rate":0.5,"locked":[]}"#;
        assert_eq!(parse_insights(unknown_plan, no_names).unwrap().completion, Gated::Locked);
    }

    #[test]
    fn a_paid_plan_gets_everything_newest_viewer_first_with_names_opened() {
        let mut asked = Vec::new();
        let i = parse_insights(PAID, |nonce, ct| {
            asked.push((nonce.to_string(), ct.to_string()));
            Some("Ahmad".into())
        })
        .unwrap();
        assert_eq!(asked, vec![("NONCE".to_string(), "CT".to_string())], "only a row with a name is opened");
        assert_eq!(i.plan, InsightsPlan::Paid);
        assert_eq!(i.completion, Gated::Shown(Some(0.25)));
        assert_eq!(i.retention, Gated::Shown(Some(vec![100.0, 100.0, 98.0, 60.0])));
        let Gated::Shown(rows) = i.viewers else { panic!("viewers shown") };
        assert_eq!(rows.iter().map(|r| r.viewer_id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(rows[0].name.as_deref(), Some("Ahmad"));
        assert_eq!(rows[0].completion, Some(1.0), "capped at 1");
        assert_eq!(rows[1].name, None, "no name: the screen says Someone");
        assert_eq!((rows[0].comments, rows[0].reactions), (1, 2));
    }

    #[test]
    fn an_access_key_accounts_generated_name_reads_as_a_short_address() {
        let generated = "user_5dsqamf3jvb3vyuxwqwux3tj6ax6ex9f5p1udjyh5tmdsk63".to_string();
        assert_eq!(readable_name(generated.clone()), "5dsqam\u{2026}sk63");
        let i = parse_insights(PAID, |_, _| Some(generated.clone())).unwrap();
        let Gated::Shown(rows) = i.viewers else { panic!("viewers shown") };
        assert_eq!(rows[0].name.as_deref(), Some("5dsqam\u{2026}sk63"));
        // Names people chose stay as they are, even ones that start the same way.
        for kept in [
            "Ahmad",
            "user_",
            "user_maya",
            "user_5dsq amf3jvb3vyuxwqwux3tj6ax6ex9f5p1udjyh5tmdsk63",
            "User_5dsqamf3jvb3vyuxwqwux3tj6ax6ex9f5p1udjyh5tmdsk63",
        ] {
            assert_eq!(readable_name(kept.to_string()), kept);
        }
    }

    #[test]
    fn a_picture_has_views_but_nothing_to_measure() {
        let image = r#"{"plan":"paid","total_views":3,"unique_viewers":2,"completion_rate":null,"retention":null,"viewers":[],"locked":[]}"#;
        let i = parse_insights(image, no_names).unwrap();
        assert_eq!(i.completion, Gated::Shown(None));
        assert_eq!(i.retention, Gated::Shown(None));
        let json = serde_json::to_value(&i).unwrap();
        assert_eq!(json["completion"], serde_json::json!({ "state": "shown", "value": null }));
    }

    fn wire_comment(id: &str, nonce: &str, ct: &str, anonymous: bool) -> WireComment {
        WireComment {
            id: serde_json::Value::String(id.into()),
            ciphertext: ct.into(),
            nonce: nonce.into(),
            at_ms: Some(83_000),
            created_at: "2026-10-13T10:00:00Z".into(),
            anonymous,
            mine: false,
        }
    }

    fn vector_key() -> (CommentKey, String, String, String) {
        let f: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/share_comments_vectors.json"
        )))
        .unwrap();
        let key: [u8; 32] = comment_crypto::decode_b64(f["share_key_b64url"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let v = &f["vectors"][0];
        (
            CommentKey::derive(&key),
            f["token"].as_str().unwrap().into(),
            v["nonce_b64"].as_str().unwrap().into(),
            v["ciphertext_b64"].as_str().unwrap().into(),
        )
    }

    #[test]
    fn comments_open_with_the_links_key() {
        let (key, token, nonce, ct) = vector_key();
        let out = open_comments(
            &token,
            vec![
                wire_comment("1", &nonce, &ct, false),
                wire_comment("2", &nonce, &ct, true),
                wire_comment("3", &nonce, "AAAA", false),
            ],
            Ok(&key),
        );
        assert_eq!(out.unreadable, None);
        assert_eq!(out.comments[0].text.as_deref(), Some("Looks great at 1:23!"));
        assert_eq!(out.comments[0].name.as_deref(), Some("Ahmad"));
        assert_eq!(out.comments[0].at_ms, Some(83_000));
        assert_eq!(out.comments[1].name, None, "an anonymous comment never shows a name");
        assert_eq!(out.comments[2].text, None, "one that does not open is kept, unread");
    }

    /// The console's comment with mentions: both come through, the owner's
    /// marked as the reader's, and the comment flagged as mentioning them.
    #[test]
    fn mentions_come_through_and_a_mention_of_the_owner_is_flagged() {
        let (key, token, _, _) = vector_key();
        let f: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/share_comments_vectors.json"
        )))
        .unwrap();
        let v = f["vectors"].as_array().unwrap().iter().find(|v| v["kind"] == "comment-mentions").unwrap();
        let nonce = v["nonce_b64"].as_str().unwrap();
        let ct = v["ciphertext_b64"].as_str().unwrap();
        let mut own = wire_comment("c-17", nonce, ct, false);
        own.mine = true;
        let out = open_comments(&token, vec![wire_comment("1", nonce, ct, false), own], Ok(&key));
        let c = &out.comments[0];
        assert_eq!(c.text.as_deref(), Some("@Owner thanks, and @Grace Liu see 0:42"));
        assert_eq!(
            c.mentions,
            vec![
                ShareCommentMention {
                    kind: MentionKind::Owner,
                    name: "Owner".into(),
                    label: "Owner".into(),
                    you: true,
                },
                ShareCommentMention {
                    kind: MentionKind::Commenter,
                    name: "Grace Liu".into(),
                    label: "Grace Liu".into(),
                    // Points at comment c-17, which is the owner's own.
                    you: true,
                },
            ]
        );
        assert!(c.mentions_you);
        assert!(!out.comments[1].mentions_you, "never on the owner's own comment");

        let json = serde_json::to_value(c).unwrap();
        assert_eq!(json["mentionsYou"], serde_json::json!(true));
        assert_eq!(json["mentions"][0]["kind"], serde_json::json!("owner"));
    }

    /// The mention list is sealed by whoever wrote the comment: one that
    /// names the owner over text that never says `@Owner` must not flag the
    /// comment as mentioning them.
    #[test]
    fn a_mention_missing_from_the_text_is_dropped() {
        use base64::Engine as _;
        let (key, token, _, _) = vector_key();
        let seal = |plaintext: serde_json::Value| {
            let nonce = [7u8; 12];
            let ct =
                comment_crypto::seal_with_nonce(&key, &token, comment_crypto::Purpose::Comment, &nonce, plaintext.to_string().as_bytes()).unwrap();
            let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
            (b64(&nonce), b64(&ct))
        };
        let (n1, c1) = seal(serde_json::json!({
            "text": "Mentioned you! Click here",
            "mentions": [{ "kind": "owner", "name": "Owner" }],
        }));
        let (n2, c2) = seal(serde_json::json!({
            "text": "@Owner have a look",
            "mentions": [{ "kind": "owner", "name": "Owner" }, { "kind": "commenter", "name": "Grace", "comment": "c-1" }],
        }));
        let out = open_comments(
            &token,
            vec![wire_comment("1", &n1, &c1, false), wire_comment("2", &n2, &c2, false)],
            Ok(&key),
        );
        assert!(out.comments[0].mentions.is_empty(), "no @Owner in the text");
        assert!(!out.comments[0].mentions_you);
        assert_eq!(out.comments[1].mentions.len(), 1, "only the mention the text holds");
        assert_eq!(out.comments[1].mentions[0].name, "Owner");
        assert!(out.comments[1].mentions_you);
    }

    #[test]
    fn a_comment_without_mentions_has_none() {
        let (key, token, nonce, ct) = vector_key();
        let out = open_comments(&token, vec![wire_comment("1", &nonce, &ct, false)], Ok(&key));
        assert!(out.comments[0].mentions.is_empty());
        assert!(!out.comments[0].mentions_you);
    }

    #[test]
    fn without_the_key_every_comment_is_listed_unread_with_the_reason() {
        let (_, token, nonce, ct) = vector_key();
        let out = open_comments(&token, vec![wire_comment("1", &nonce, &ct, false)], Err(KeyUnavailable::Password));
        assert_eq!(out.comments[0].text, None);
        assert_eq!(out.comments[0].name, None);
        assert!(out.unreadable.unwrap().contains("password"));
    }

    #[test]
    fn switches_are_offered_by_capability_and_never_for_folders() {
        let none = ServerCapabilities::default();
        let insights = ServerCapabilities {
            share_insights: true,
            ..Default::default()
        };
        let all = ServerCapabilities {
            share_insights: true,
            share_comments: true,
            ..Default::default()
        };
        assert_eq!(default_for(false, true, true, &none, PLAN_PAID).offered, OfferedSwitches::default());
        let only = default_for(false, true, true, &insights, PLAN_PAID);
        assert_eq!(
            only.offered,
            OfferedSwitches {
                insights: true,
                comments: false,
                reactions: false
            }
        );
        assert_eq!(
            only.on,
            LinkSettings {
                insights: true,
                ..Default::default()
            }
        );
        assert_eq!(default_for(true, true, true, &all, PLAN_PAID).offered, OfferedSwitches::default());
    }

    /// On for screenshots and recordings (while Settings says so), off for
    /// every other file.
    #[test]
    fn the_defaults_are_on_for_captures_and_off_for_other_files() {
        let all = ServerCapabilities {
            share_insights: true,
            share_comments: true,
            ..Default::default()
        };
        assert_eq!(default_for(false, true, true, &all, PLAN_PAID).on, LinkSettings::all(true));
        assert_eq!(default_for(false, false, true, &all, PLAN_PAID).on, LinkSettings::all(false));
        assert_eq!(
            default_for(false, true, false, &all, PLAN_PAID).on,
            LinkSettings::all(false),
            "Settings off"
        );
        assert_eq!(for_capture(true), LinkSettings::all(true));
        assert_eq!(for_capture(false), LinkSettings::all(false));
    }

    const PLAN_PAID: Option<bool> = Some(true);
    const PLAN_FREE: Option<bool> = Some(false);
    const PLAN_UNKNOWN: Option<bool> = None;

    /// The plan comes from the same read as the watermark and the recording
    /// limit: a paid Drive plan includes the switches, the free plan does
    /// not, and a read that could not tell says so.
    #[test]
    fn the_switches_come_with_a_paid_plan_only() {
        use crate::capture::allowance::RecordingTier;
        assert_eq!(switches_in_plan(Some(RecordingTier::Paid)), PLAN_PAID);
        assert_eq!(switches_in_plan(Some(RecordingTier::Free)), PLAN_FREE);
        assert_eq!(switches_in_plan(None), PLAN_UNKNOWN);
    }

    /// A new link gets Insights, Comments and Reactions on a paid plan, never
    /// on the free plan, and not when the plan could not be read.
    #[test]
    fn a_new_link_gets_its_switches_on_a_paid_plan_only() {
        let all = LinkSettings::all(true);
        let none = LinkSettings::all(false);
        assert_eq!(within_plan(all, PLAN_PAID), all, "paid: all on");
        assert_eq!(within_plan(all, PLAN_FREE), none, "free: all off");
        assert_eq!(within_plan(all, PLAN_UNKNOWN), none, "lookup failed: all off");
        assert_eq!(within_plan(none, PLAN_PAID), none);
        for one in [
            LinkSettings { insights: true, ..none },
            LinkSettings { comments: true, ..none },
            LinkSettings { reactions: true, ..none },
        ] {
            assert_eq!(within_plan(one, PLAN_PAID), one);
            assert_eq!(within_plan(one, PLAN_FREE), none, "{one:?}");
            assert_eq!(within_plan(one, PLAN_UNKNOWN), none, "{one:?}");
        }
        // A capture's own link follows the same rule.
        assert_eq!(within_plan(for_capture(true), PLAN_FREE), none);
        assert_eq!(within_plan(for_capture(true), PLAN_PAID), all);
    }

    /// The share dialog starts a capture's switches on only for a paid plan,
    /// still offers them on the free plan (where they lead to the upgrade
    /// prompt), and says which plan it is.
    #[test]
    fn the_dialog_starts_every_switch_off_on_the_free_plan() {
        let all = ServerCapabilities {
            share_insights: true,
            share_comments: true,
            ..Default::default()
        };
        let paid = default_for(false, true, true, &all, PLAN_PAID);
        assert_eq!(paid.on, LinkSettings::all(true));
        assert_eq!(paid.switches_in_plan, PLAN_PAID);
        for plan in [PLAN_FREE, PLAN_UNKNOWN] {
            let d = default_for(false, true, true, &all, plan);
            assert_eq!(d.on, LinkSettings::all(false), "{plan:?}");
            assert_eq!(
                d.offered,
                OfferedSwitches {
                    insights: true,
                    comments: true,
                    reactions: true
                },
                "the switches are still shown: {plan:?}"
            );
            assert_eq!(d.switches_in_plan, plan);
        }
        let json = serde_json::to_value(default_for(false, true, true, &all, PLAN_FREE)).unwrap();
        assert_eq!(json["switchesInPlan"], false);
        let json = serde_json::to_value(default_for(false, true, true, &all, PLAN_UNKNOWN)).unwrap();
        assert!(json["switchesInPlan"].is_null());
    }

    /// Turning any switch on from the free plan is refused; a plan that
    /// could not be read, or a paid one, blocks nothing.
    #[test]
    fn switching_any_of_the_three_on_from_the_free_plan_is_refused() {
        let off = LinkSettings::all(false);
        for one in [
            LinkSettings { insights: true, ..off },
            LinkSettings { comments: true, ..off },
            LinkSettings { reactions: true, ..off },
        ] {
            assert!(refuses_switching_on(one, off, PLAN_FREE), "{one:?}");
            assert!(!refuses_switching_on(one, off, PLAN_PAID), "{one:?}");
            assert!(!refuses_switching_on(one, off, PLAN_UNKNOWN), "a failed read never blocks: {one:?}");
        }
        assert!(refuses_switching_on(LinkSettings::all(true), off, PLAN_FREE));
    }

    /// An existing free link keeps the switches it has and can turn any of
    /// them off, but not one it has off back on.
    #[test]
    fn an_existing_free_link_keeps_its_switches_and_can_turn_them_off() {
        let was = LinkSettings {
            insights: false,
            comments: true,
            reactions: true,
        };
        assert!(!refuses_switching_on(was, was, PLAN_FREE), "left as it is");
        let comments_off = LinkSettings { comments: false, ..was };
        assert!(!refuses_switching_on(comments_off, was, PLAN_FREE), "comments off");
        let reactions_off = LinkSettings { reactions: false, ..was };
        assert!(!refuses_switching_on(reactions_off, was, PLAN_FREE), "reactions off");
        assert!(
            !refuses_switching_on(LinkSettings::all(false), LinkSettings::all(true), PLAN_FREE),
            "all off"
        );
        assert!(
            refuses_switching_on(LinkSettings::all(true), was, PLAN_FREE),
            "insights back on is refused"
        );
        assert!(
            refuses_switching_on(was, reactions_off, PLAN_FREE),
            "reactions back on once off is refused"
        );
    }

    /// What `share_set_link_settings` checks against the plan: only the
    /// switches the patch turns on, never one it turns off or leaves out.
    #[test]
    fn the_plan_check_looks_only_at_switches_turned_on() {
        let patch = SettingsPatch {
            insights: Some(false),
            comments: Some(true),
            reactions: None,
        };
        assert_eq!(
            patch.asked_on(),
            LinkSettings {
                insights: false,
                comments: true,
                reactions: false
            }
        );
        assert!(!SettingsPatch::default().asked_on().any());
    }

    #[test]
    fn the_patch_carries_only_what_the_server_takes() {
        let all = OfferedSwitches {
            insights: true,
            comments: true,
            reactions: true,
        };
        let insights_only = OfferedSwitches {
            insights: true,
            ..Default::default()
        };
        let on = LinkSettings::all(true);
        assert_eq!(
            serde_json::to_value(patch_for(on, all, true).unwrap()).unwrap(),
            serde_json::json!({"insights": true, "comments": true, "reactions": true})
        );
        assert_eq!(
            serde_json::to_value(patch_for(on, insights_only, true).unwrap()).unwrap(),
            serde_json::json!({"insights": true})
        );
        assert_eq!(
            patch_for(on, OfferedSwitches::default(), true),
            None,
            "nothing is sent to an older server"
        );
        assert_eq!(patch_for(LinkSettings::all(false), all, true), None, "a new link starts all off");
        assert_eq!(
            serde_json::to_value(patch_for(LinkSettings::all(false), all, false).unwrap()).unwrap(),
            serde_json::json!({"insights": false, "comments": false, "reactions": false}),
            "turning an existing link's switches off is sent"
        );
    }

    /// A change sends only the switch the owner flipped, so turning Comments
    /// off can never put Insights or Reactions back the way an older screen
    /// had them.
    #[test]
    fn a_change_sends_only_the_switch_that_was_flipped() {
        let all = OfferedSwitches {
            insights: true,
            comments: true,
            reactions: true,
        };
        let change: SettingsPatch = serde_json::from_value(serde_json::json!({"comments": false})).unwrap();
        assert_eq!(
            serde_json::to_value(change_for(change, all).unwrap()).unwrap(),
            serde_json::json!({"comments": false})
        );
        let insights_only = OfferedSwitches {
            insights: true,
            ..Default::default()
        };
        assert_eq!(change_for(change, insights_only), None, "a switch the server does not take is not sent");
        assert_eq!(change_for(SettingsPatch::default(), all), None, "nothing flipped, nothing sent");
    }

    /// The owner can flip a switch on a link made seconds ago. Its own
    /// switches, still being sent in the background, must land first, or they
    /// would put back what the owner just turned off.
    #[tokio::test]
    async fn reading_or_changing_a_new_links_switches_waits_for_its_own_to_be_sent() {
        let sending = SendingSwitches::begin("tok-waits");
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let waiter = {
            let done = Arc::clone(&done);
            tokio::spawn(async move {
                after_mint_switches_sent("tok-waits").await;
                done.store(true, std::sync::atomic::Ordering::SeqCst);
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !done.load(std::sync::atomic::Ordering::SeqCst),
            "held while the new link's switches are on their way"
        );
        drop(sending);
        waiter.await.unwrap();
        assert!(done.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            !SENDING_AFTER_MINT.lock().unwrap().contains_key("tok-waits"),
            "a finished send leaves nothing behind"
        );
        // A link with nothing on its way is read or changed at once.
        tokio::time::timeout(Duration::from_millis(100), after_mint_switches_sent("tok-idle"))
            .await
            .expect("no wait");
    }

    #[test]
    fn notification_preferences_read_leniently_and_write_snake_case() {
        assert_eq!(
            parse_preferences(r#"{"first_views":false,"comments":true,"digest":"daily"}"#).unwrap(),
            NotificationPreferences {
                first_views: false,
                comments: true,
                digest: Digest::Daily
            }
        );
        assert_eq!(parse_preferences("{}").unwrap(), NotificationPreferences::default());
        assert_eq!(parse_preferences(r#"{"digest":"monthly"}"#).unwrap().digest, Digest::Weekly);
        assert_eq!(
            preferences_body(NotificationPreferences {
                first_views: true,
                comments: false,
                digest: Digest::Off
            }),
            serde_json::json!({"first_views": true, "comments": false, "digest": "off"})
        );
        // The IPC side is camelCase.
        let ipc = serde_json::to_value(NotificationPreferences::default()).unwrap();
        assert_eq!(ipc, serde_json::json!({"firstViews": true, "comments": true, "digest": "weekly"}));
    }

    // ─── Against a mock server ─────────────────────────────────────────────

    #[derive(Debug, Clone)]
    struct Seen {
        method: String,
        path: String,
        query: Option<String>,
        auth: Option<String>,
        body: String,
    }

    /// A loopback server that records each request and answers from `reply`.
    async fn mock(reply: impl Fn(&Seen) -> (u16, String) + Send + Sync + 'static) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let reply = Arc::new(reply);
        let log = seen.clone();
        let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
            let (log, reply) = (log.clone(), reply.clone());
            async move {
                let (parts, body) = req.into_parts();
                let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap_or_default();
                let s = Seen {
                    method: parts.method.to_string(),
                    path: parts.uri.path().to_string(),
                    query: parts.uri.query().map(str::to_string),
                    auth: parts.headers.get("authorization").and_then(|v| v.to_str().ok()).map(str::to_string),
                    body: String::from_utf8_lossy(&bytes).into_owned(),
                };
                let (status, out) = reply(&s);
                log.lock().unwrap().push(s);
                (axum::http::StatusCode::from_u16(status).unwrap(), out)
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), seen)
    }

    /// The token in a share route opens the link's preview, so a request
    /// that fails must not carry its URL into the panel or the logs.
    #[tokio::test]
    async fn a_failed_request_never_names_its_url() {
        let e = reqwest::Client::new()
            .get("http://127.0.0.1:9/v1/shares/SECRET-LINK-TOKEN/insights")
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .expect_err("nothing listens on the discard port");
        let text = transport("insights", e).to_string();
        assert!(!text.contains("SECRET-LINK-TOKEN"), "token leaked: {text}");
        assert!(!text.contains("127.0.0.1"), "url leaked: {text}");
        assert!(text.contains("insights failed: couldn't reach Hippius"), "got: {text}");
    }

    #[tokio::test]
    async fn settings_are_patched_on_the_links_route_with_the_owners_bearer() {
        let (base, seen) = mock(|_| (204, String::new())).await;
        let api = Api::new(&base, "owner-bearer");
        let patch = SettingsPatch {
            insights: Some(true),
            comments: Some(false),
            reactions: None,
        };
        patch_settings(&reqwest::Client::new(), &api, "tok_1", &patch).await.unwrap();
        let s = seen.lock().unwrap()[0].clone();
        assert_eq!((s.method.as_str(), s.path.as_str()), ("PATCH", "/v1/shares/tok_1/settings"));
        assert_eq!(s.auth.as_deref(), Some("Bearer owner-bearer"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&s.body).unwrap(),
            serde_json::json!({"insights": true, "comments": false})
        );
    }

    #[tokio::test]
    async fn a_refused_patch_is_an_error_and_a_gone_link_says_so() {
        let (base, _) = mock(|s| {
            if s.path.contains("gone") {
                (404, String::new())
            } else {
                (500, "boom".into())
            }
        })
        .await;
        let api = Api::new(&base, "b");
        let http = reqwest::Client::new();
        let patch = SettingsPatch {
            insights: Some(true),
            ..Default::default()
        };
        assert!(matches!(
            patch_settings(&http, &api, "tok", &patch).await,
            Err(AppError::Api { status: 500, .. })
        ));
        assert!(matches!(patch_settings(&http, &api, "gone", &patch).await, Err(AppError::NotFound(m)) if m == LINK_GONE));
    }

    #[tokio::test]
    async fn insights_are_read_from_the_links_route() {
        let (base, seen) = mock(|_| (200, FREE.into())).await;
        let body = get_insights_body(&reqwest::Client::new(), &Api::new(&base, "b"), "tok").await.unwrap();
        assert_eq!(parse_insights(&body, no_names).unwrap().viewers, Gated::Locked);
        assert_eq!(seen.lock().unwrap()[0].path, "/v1/shares/tok/insights");
    }

    #[tokio::test]
    async fn comments_follow_the_cursor_and_stop_when_it_ends() {
        let (base, seen) = mock(|s| match s.query.as_deref() {
            None => (
                200,
                r#"{"comments":[{"id":"1","ciphertext":"x","nonce":"y","created_at":"t"}],"next":"1"}"#.into(),
            ),
            Some("after=1") => (
                200,
                r#"{"comments":[{"id":2,"ciphertext":"x","nonce":"y","created_at":"t"}],"next":null}"#.into(),
            ),
            _ => (500, String::new()),
        })
        .await;
        let all = get_all_comments(&reqwest::Client::new(), &Api::new(&base, "b"), "tok").await.unwrap();
        assert_eq!(all.iter().map(WireComment::id).collect::<Vec<_>>(), ["1", "2"]);
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_cursor_is_passed_back_exactly() {
        assert_eq!(query_value("abc-1_2.3~"), "abc-1_2.3~");
        assert_eq!(query_value("2026-10-13T10:00:00Z&x=1"), "2026-10-13T10%3A00%3A00Z%26x%3D1");
        assert_eq!(query_value("a b/é"), "a%20b%2F%C3%A9");
    }

    #[tokio::test]
    async fn a_bare_list_is_one_page_and_a_stuck_cursor_does_not_loop() {
        let (base, seen) = mock(|_| (200, r#"[{"id":"1","ciphertext":"x","nonce":"y","created_at":"t"}]"#.into())).await;
        let http = reqwest::Client::new();
        assert_eq!(get_all_comments(&http, &Api::new(&base, "b"), "tok").await.unwrap().len(), 1);
        assert_eq!(seen.lock().unwrap().len(), 1);

        let (base, seen) = mock(|_| {
            (
                200,
                r#"{"comments":[{"id":"1","ciphertext":"x","nonce":"y","created_at":"t"}],"next":"same"}"#.into(),
            )
        })
        .await;
        assert_eq!(get_all_comments(&http, &Api::new(&base, "b"), "tok").await.unwrap().len(), 1);
        assert_eq!(seen.lock().unwrap().len(), 2, "the repeat page ends it");
    }

    #[tokio::test]
    async fn deleting_a_comment_targets_it_and_an_already_gone_one_is_fine() {
        let (base, seen) = mock(|s| {
            if s.path.ends_with("/gone") {
                (404, String::new())
            } else {
                (204, String::new())
            }
        })
        .await;
        let (http, api) = (reqwest::Client::new(), Api::new(&base, "b"));
        delete_comment_at(&http, &api, "tok", "c-1").await.unwrap();
        delete_comment_at(&http, &api, "tok", "gone").await.unwrap();
        let s = seen.lock().unwrap()[0].clone();
        assert_eq!((s.method.as_str(), s.path.as_str()), ("DELETE", "/v1/shares/tok/comments/c-1"));
        // An id that is not one path segment never becomes a request.
        for bad in ["../../settings", "a/b", "", "a b", "a?x=1"] {
            assert!(
                matches!(delete_comment_at(&http, &api, "tok", bad).await, Err(AppError::Validation(_))),
                "{bad}"
            );
        }
        assert!(matches!(get_insights_body(&http, &api, "../x").await, Err(AppError::Validation(_))));
        assert_eq!(seen.lock().unwrap().len(), 2, "nothing was sent for them");
    }

    #[tokio::test]
    async fn blocking_posts_and_unblocking_deletes_on_the_comments_block_route() {
        let (base, seen) = mock(|_| (204, String::new())).await;
        let (http, api) = (reqwest::Client::new(), Api::new(&base, "owner-bearer"));
        set_comment_author_blocked(&http, &api, "tok", "41", true).await.unwrap();
        set_comment_author_blocked(&http, &api, "tok", "41", false).await.unwrap();
        {
            let seen = seen.lock().unwrap();
            assert_eq!(
                (seen[0].method.as_str(), seen[0].path.as_str()),
                ("POST", "/v1/shares/tok/comments/41/block")
            );
            assert_eq!(
                (seen[1].method.as_str(), seen[1].path.as_str()),
                ("DELETE", "/v1/shares/tok/comments/41/block")
            );
            assert_eq!(seen[0].auth.as_deref(), Some("Bearer owner-bearer"));
            assert!(seen[0].body.is_empty(), "the block carries no body");
        }
        // Unlike a delete, a block on a comment that is gone did nothing, so
        // it is not reported as done.
        assert!(matches!(
            set_comment_author_blocked(&http, &api, "tok", "gone/x", true).await,
            Err(AppError::Validation(_))
        ));
        let (base, _) = mock(|_| (404, String::new())).await;
        assert!(matches!(
            set_comment_author_blocked(&http, &Api::new(&base, "b"), "tok", "41", true).await,
            Err(AppError::NotFound(m)) if m == COMMENT_GONE
        ));
        assert_eq!(seen.lock().unwrap().len(), 2, "an id that is not one segment is never sent");
    }

    #[test]
    fn reactions_come_in_the_share_pages_order_with_one_heart() {
        let r = parse_reactions(r#"{"counts":{"🔥":2,"👍":3,"❤️":1,"❤":1,"🤖":9,"🙌":0},"mine":["👍"]}"#).unwrap();
        assert_eq!(
            r.counts.iter().map(|c| (c.emoji.as_str(), c.count)).collect::<Vec<_>>(),
            [("👍", 3), ("❤️", 2), ("🔥", 2)],
            "page order, a bare heart counted with the full one, zero and unknown left out"
        );
        assert_eq!(r.total, 7);
        assert_eq!(parse_reactions(r#"{"counts":{},"mine":[]}"#).unwrap().total, 0);
        assert_eq!(parse_reactions("{}").unwrap().counts, []);
        // camelCase over IPC.
        assert_eq!(
            serde_json::to_value(&r).unwrap()["counts"][0],
            serde_json::json!({"emoji": "👍", "count": 3})
        );
    }

    #[tokio::test]
    async fn reactions_and_switches_are_read_from_the_links_routes() {
        let (base, seen) = mock(|s| match s.path.as_str() {
            "/v1/shares/tok/reactions" => (200, r#"{"counts":{"🎉":1},"mine":[]}"#.into()),
            "/v1/shares/tok/meta" => (
                200,
                r#"{"ciphertext_size":1,"plaintext_size":1,"filename_ct":"x","filename_nonce":"y","mime_type":"video/mp4","expires_at":null,"settings":{"insights":true,"comments":false,"reactions":true}}"#.into(),
            ),
            "/v1/shares/old/meta" => (200, r#"{"ciphertext_size":1}"#.into()),
            _ => (404, String::new()),
        })
        .await;
        let (http, api) = (reqwest::Client::new(), Api::new(&base, "owner-bearer"));
        let r = parse_reactions(&get_reactions_body(&http, &api, "tok").await.unwrap()).unwrap();
        assert_eq!(r.total, 1);
        let on = parse_meta_settings(&get_meta_body(&http, &api, "tok").await.unwrap()).unwrap();
        assert_eq!(
            on,
            LinkSettings {
                insights: true,
                comments: false,
                reactions: true
            }
        );
        assert_eq!(
            parse_meta_settings(&get_meta_body(&http, &api, "old").await.unwrap()).unwrap(),
            LinkSettings::all(false),
            "a server without switches reads as all off"
        );
        assert!(matches!(get_meta_body(&http, &api, "gone").await, Err(AppError::NotFound(m)) if m == LINK_GONE));
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].auth.as_deref(), Some("Bearer owner-bearer"));
        assert_eq!(seen[1].auth, None, "/meta is the recipient's route and gets no bearer");
    }

    #[tokio::test]
    async fn notification_preferences_round_trip_the_server() {
        let (base, seen) = mock(|s| {
            if s.method == "GET" {
                (200, r#"{"first_views":true,"comments":false,"digest":"off"}"#.into())
            } else {
                (204, String::new())
            }
        })
        .await;
        let (http, api) = (reqwest::Client::new(), Api::new(&base, "b"));
        let prefs = get_preferences(&http, &api).await.unwrap();
        assert_eq!(prefs.digest, Digest::Off);
        put_preferences(
            &http,
            &api,
            NotificationPreferences {
                digest: Digest::Daily,
                ..prefs
            },
        )
        .await
        .unwrap();
        let s = seen.lock().unwrap()[1].clone();
        assert_eq!((s.method.as_str(), s.path.as_str()), ("PUT", "/v1/notification-preferences"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&s.body).unwrap(),
            serde_json::json!({"first_views": true, "comments": false, "digest": "daily"})
        );
    }
}
