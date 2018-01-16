// @flow
import UserError from '../utils/UserError';
import {
  getChannels,
  getChannelBySlug,
  editChannel,
  createChannel,
  deleteChannel,
} from '../models/channel';
import {
  getCommunities,
  userIsMemberOfAnyChannelInCommunity,
} from '../models/community';
import {
  getUserPermissionsInCommunity,
  createMemberInCommunity,
  removeMemberInCommunity,
} from '../models/usersCommunities';
import {
  getUserPermissionsInChannel,
  createMemberInChannel,
  removeMemberInChannel,
  unblockMemberInChannel,
  removeMembersInChannel,
  createOwnerInChannel,
  createOrUpdatePendingUserInChannel,
  createMemberInDefaultChannels,
  blockUserInChannel,
  approvePendingUserInChannel,
  approvePendingUsersInChannel,
  toggleUserChannelNotifications,
} from '../models/usersChannels';
import type {
  CreateChannelArguments,
  EditChannelArguments,
} from '../models/channel';
import { getThreadsByChannelToDelete, deleteThread } from '../models/thread';
import { channelSlugIsBlacklisted } from '../utils/permissions';
import { addQueue } from '../utils/workerQueue';
import type { GraphQLContext } from '../';

type Contact = {
  email: string,
  firstName: ?string,
};
type EmailInvitesInput = {
  customMessage: ?string,
  contacts: Array<Contact>,
  id: string,
};
type UnblockInput = {
  channelId: string,
  userId: string,
};
type TogglePendingInput = {
  channelId: string,
  userId: string,
  action: 'block' | 'approve',
};

module.exports = {
  Mutation: {
    createChannel: async (
      _: any,
      args: CreateChannelArguments,
      { user }: GraphQLContext
    ) => {
      const currentUser = user;

      // user must be authed to create a channel
      if (!currentUser) {
        return new UserError(
          'You must be signed in to create a new community.'
        );
      }

      if (channelSlugIsBlacklisted(args.input.slug)) {
        return new UserError('This channel name is reserved.');
      }

      // get the community parent where the channel is being created
      const getCommunitiesRecords = getCommunities([args.input.communityId]);

      // get the permission of the user in the parent community
      const getCurrentUserCommunityPermissions = getUserPermissionsInCommunity(
        args.input.communityId,
        currentUser.id
      );

      const [communities, currentUserCommunityPermissions] = await Promise.all([
        getCommunitiesRecords,
        getCurrentUserCommunityPermissions,
      ]);

      // select the community to evaluate
      const communityToEvaluate = communities[0];

      // if there is no community being evaluated, we can assume the
      // community doesn't exist any more
      if (!communityToEvaluate) {
        return new UserError(
          "You don't have permission to create a channel in this community."
        );
      }

      // if the current user is not the owner of the parent community
      // they can not create channels
      if (!currentUserCommunityPermissions.isOwner) {
        return new UserError(
          "You don't have permission to create a channel in this community."
        );
      }

      const channelWithSlug = await getChannelBySlug(
        args.input.slug,
        communityToEvaluate.slug
      );

      // if a channel is returned, it means a duplicate was being created
      // so we need to escape
      if (channelWithSlug) {
        return new UserError('A channel with this slug already exists.');
      }

      // if no channel was returned, it means we are creating a unique
      // new channel and can proceed
      const newChannel = await createChannel(args, currentUser.id);
      return Promise.all([
        createOwnerInChannel(newChannel.id, currentUser.id),
      ]).then(() => newChannel);
    },
    deleteChannel: async (
      _: any,
      { channelId }: { channelId: string },
      { user }: GraphQLContext
    ) => {
      const currentUser = user;

      // user must be authed to delete a channel
      if (!currentUser) {
        return new UserError(
          'You must be signed in to make changes to this channel.'
        );
      }

      // get the channel's permissions
      const getCurrentUserChannelPermissions = getUserPermissionsInChannel(
        channelId,
        currentUser.id
      );

      // get the channel to evaluate
      const getChannelRecords = getChannels([channelId]);

      const [channels, currentUserChannelPermissions] = await Promise.all([
        getChannelRecords,
        getCurrentUserChannelPermissions,
      ]);

      const channelToEvaluate = channels[0];

      // if channel wasn't found or was previously deleted, something
      // has gone wrong and we need to escape
      if (!channelToEvaluate || channelToEvaluate.deletedAt) {
        return new UserError("Channel doesn't exist");
      }

      // get the community parent of the channel being deleted
      const currentUserCommunityPermissions = await getUserPermissionsInCommunity(
        channelToEvaluate.communityId,
        currentUser.id
      );

      if (
        !currentUserChannelPermissions.isOwner &&
        !currentUserCommunityPermissions.isOwner
      ) {
        // if the currentUser does not own the channel or the parent
        // community they can not delete the channel
        return new UserError(
          "You don't have permission to make changes to this channel"
        );
      }

      // all checks passed
      // delete the channel requested from the client side user
      const deleteTheInputChannel = deleteChannel(channelId);
      // get all the threads in the channel to prepare for deletion
      const getAllThreadsInChannel = getThreadsByChannelToDelete(channelId);
      // update all the UsersChannels objects in the db to be non-members
      const removeRelationships = removeMembersInChannel(channelId);

      const [
        deletedInputChannel,
        allThreadsInChannel,
        removedRelationships,
      ] = await Promise.all([
        deleteTheInputChannel,
        getAllThreadsInChannel,
        removeRelationships,
      ]);

      // if there were no threads in that channel, we are done
      if (allThreadsInChannel.length === 0) return;

      // otherwise we need to mark all the threads in that channel
      // as deleted
      return allThreadsInChannel.map(thread => deleteThread(thread.id));
    },
    editChannel: async (
      _: any,
      args: EditChannelArguments,
      { user }: GraphQLContext
    ) => {
      const currentUser = user;

      // user must be authed to edit a channel
      if (!currentUser) {
        return new UserError(
          'You must be signed in to make changes to this channel.'
        );
      }

      // get the user's permission in this channel
      const getCurrentUserChannelPermissions = getUserPermissionsInChannel(
        args.input.channelId,
        currentUser.id
      );

      // get the channel to evaluate
      const getChannelRecords = getChannels([args.input.channelId]);

      const [channels, currentUserChannelPermissions] = await Promise.all([
        getCurrentUserChannelPermissions,
        getChannelRecords,
      ]);

      // select the channel to evaluate
      const channelToEvaluate = channels[0];

      // if a channel wasn't found or was deleted
      if (!channelToEvaluate || channelToEvaluate.deletedAt) {
        return new UserError("This channel doesn't exist");
      }

      // get the community parent of the channel being deleted
      const currentUserCommunityPermissions = await getUserPermissionsInCommunity(
        channelToEvaluate.communityId,
        currentUser.id
      );

      // if the user owns the community or owns the channel, they
      // are allowed to make the changes
      if (
        currentUserCommunityPermissions.isOwner ||
        currentUserChannelPermissions.isOwner
      ) {
        // all checks passed
        // if a channel is being converted from private to public, make
        // all the pending users members in the channel
        if (channelToEvaluate.isPrivate && !args.input.isPrivate) {
          approvePendingUsersInChannel(args.input.channelId);
        }

        return editChannel(args);
      }

      // otherwise the user does not have permission
      return new UserError(
        "You don't have permission to make changes to this channel."
      );
    },
    toggleChannelSubscription: async (
      _: any,
      { channelId }: { channelId: string },
      { user }: GraphQLContext
    ) => {
      const currentUser = user;

      // user must be authed to join a channel
      if (!currentUser) {
        return new UserError('You must be signed in to follow this channel.');
      }

      // get the channel to evaluate
      const getChannelRecords = getChannels([channelId]);
      const getCurrentUserPermissionsInChannel = getUserPermissionsInChannel(
        channelId,
        currentUser.id
      );

      const [channels, currentUserChannelPermissions] = await Promise.all([
        getChannelRecords,
        getCurrentUserPermissionsInChannel,
      ]);

      // select the channel
      const channelToEvaluate = channels[0];

      // if channel wasn't found or was deleted
      if (!channelToEvaluate || channelToEvaluate.deletedAt) {
        return new UserError("This channel doesn't exist");
      }

      // user is blocked, they can't join the channel
      if (currentUserChannelPermissions.isBlocked) {
        return new UserError("You don't have permission to do that.");
      }

      // if the person owns the channel, they have accidentally triggered
      // a join or leave action, which isn't allowed
      if (currentUserChannelPermissions.isOwner) {
        return new UserError(
          "Owners of a community can't join or leave their own channel."
        );
      }

      // if the user is a member of the channel, it means they are trying
      // to leave the channel
      if (currentUserChannelPermissions.isMember) {
        // remove the relationship of the user to the channel
        const removeRelationship = removeMemberInChannel(
          channelId,
          currentUser.id
        );

        return Promise.all([removeRelationship])
          .then(async () => {
            // check to see if the user is a member of any other channels
            // in that community. if they are, we can return. if they are
            // not a member of any other channels in that community then we
            // know that this is the *last* channel they are leaving and they
            // should also be removed from the parent community itself
            const isMemberOfAnotherChannel = await userIsMemberOfAnyChannelInCommunity(
              channelToEvaluate.communityId,
              currentUser.id
            );

            // if they are a member of another channel, we can continue
            if (isMemberOfAnotherChannel) {
              return;
            } else {
              // otherwise if this is the last channel they are leaving
              // in that community, the user should also be removed from
              // the community
              return await removeMemberInCommunity(
                channelToEvaluate.communityId,
                currentUser.id
              );
            }
          })
          .then(() => channelToEvaluate);
      } else {
        // the user is not a member of the current channel, which means
        // that they are trying to join this channel.
        // we need to check a few things:
        // 1. if the channel is private, and the user is already pending,
        //    remove their relationship from the channel
        // 2. if the channel is private and the user is not already pending,
        //    create a new pending relationship with the channel

        // 1. user has already requested to join, so remove them from pending
        if (currentUserChannelPermissions.isPending) {
          return removeMemberInChannel(channelId, currentUser.id);
        }

        // 2. if the channel is private, request to join - since this action
        // doesn't actually join the channel, we don't need to perform
        // the downstream checks to see if the user needs to join the parent
        // community - those actions will instead be handled when the channel
        // owner approves the user
        if (channelToEvaluate.isPrivate) {
          const [channel, _] = await Promise.all([
            // create a pending users channels record
            createOrUpdatePendingUserInChannel(channelId, currentUser.id),
            // notify the community owners via email and in-app notification => athena
            addQueue('private channel request sent', {
              userId: currentUser.id,
              channel: channelToEvaluate,
            }),
          ]);

          return channel;
        }

        // otherwise the channel is not private so the user can just join.
        // we'll create new usersChannels relationship
        const joinedChannel = await createMemberInChannel(
          channelId,
          currentUser.id
        );

        // we also need to see if the user is a member of the parent community.
        // if they are, we can just continue
        // otherwise this tells us that the user is joining the community
        // for the first time so we will create that relationship, as well
        // as create relationships between the user and all the default
        // channels in that community

        // get the current user's permissions in the community
        const currentUserCommunityPermissions = await getUserPermissionsInCommunity(
          channelToEvaluate.communityId,
          currentUser.id
        );

        // if the user is a member of the parent community, we can return
        if (currentUserCommunityPermissions.isMember) {
          return joinedChannel;
        } else {
          // if the user is not a member of the parent community,
          // join the community and the community's default channels
          return Promise.all([
            createMemberInCommunity(joinedChannel.communityId, currentUser.id),
            createMemberInDefaultChannels(
              joinedChannel.communityId,
              currentUser.id
            ),
          ]).then(() => joinedChannel);
        }
      }
    },
    toggleChannelNotifications: (
      _: any,
      { channelId }: { channelId: string },
      { user }: GraphQLContext
    ) => {
      const currentUser = user;

      // user must be authed to join a channel
      if (!currentUser) {
        return new UserError(
          'You must be signed in to get notifications for this channel.'
        );
      }

      // get the current user's permissions in the channel
      return getUserPermissionsInChannel(channelId, currentUser.id)
        .then(permissions => {
          // user is blocked, they can't join the channel
          if (permissions.isBlocked || !permissions.isMember) {
            return new UserError("You don't have permission to do that.");
          }

          // pass in the oppositve value of the current user's subscriptions
          const value = !permissions.receiveNotifications;
          return toggleUserChannelNotifications(
            currentUser.id,
            channelId,
            value
          );
        })
        .then(async () => {
          // return the channel being evaluated
          const channelRecords = await getChannels([channelId]);
          return channelRecords[0];
        });
    },
    togglePendingUser: async (
      _: any,
      { input }: { input: TogglePendingInput },
      { user }: GraphQLContext
    ) => {
      const currentUser = user;

      // user must be authed to edit a channel
      if (!currentUser)
        return new UserError(
          'You must be signed in to make changes to this channel.'
        );

      // get the channel's permissions for the current user
      const getCurrentUserChannelPermissions = getUserPermissionsInChannel(
        input.channelId,
        currentUser.id
      );

      // get the channel's permissions for the user being toggled
      const getEvaluatedUserPermissions = getUserPermissionsInChannel(
        input.channelId,
        input.userId
      );

      // get the channel object to be evaluated
      const getChannelRecords = getChannels([input.channelId]);

      const [
        channelPermissions,
        evaluatedUserPermissions,
        channels,
      ] = await Promise.all([
        getCurrentUserChannelPermissions,
        getEvaluatedUserPermissions,
        getChannelRecords,
      ]);

      // select the channel to be evaluated
      const channelToEvaluate = channels[0];

      // if channel wasn't found or was deleted
      if (!channelToEvaluate || channelToEvaluate.deletedAt) {
        return new UserError("This channel doesn't exist");
      }

      // get the community parent of channel
      const currentUserCommunityPermissions = await getUserPermissionsInCommunity(
        channelToEvaluate.communityId,
        currentUser.id
      );

      // if the user isn't on the pending list
      if (!evaluatedUserPermissions.isPending) {
        return new UserError(
          'This user is not currently pending access to this channel.'
        );
      }

      // user is neither a community or channel owner, they don't have permission
      if (
        !channelPermissions.isOwner ||
        !currentUserCommunityPermissions.isOwner
      ) {
        return new UserError(
          "You don't have permission to make changes to this channel."
        );
      }

      // determine whether to approve or block them
      if (input.action === 'block') {
        // remove the user from the pending list
        return blockUserInChannel(input.channelId, input.userId).then(
          () => channelToEvaluate
        );
      }

      if (input.action === 'approve') {
        const approveUser = approvePendingUserInChannel(
          input.channelId,
          input.userId
        );

        // if the user is a member of the parent community, we can return
        if (currentUserCommunityPermissions.isMember) {
          return Promise.all([channelToEvaluate, approveUser]).then(() => {
            addQueue('private channel request approved', {
              userId: input.userId,
              channelId: channelToEvaluate.id,
              communityId: channelToEvaluate.communityId,
              moderatorId: currentUser.id,
            });
            return channelToEvaluate;
          });
        } else {
          // if the user is not a member of the parent community,
          // join the community and the community's default channels
          return Promise.all([
            channelToEvaluate,
            createMemberInCommunity(
              channelToEvaluate.communityId,
              input.userId
            ),
            createMemberInDefaultChannels(
              channelToEvaluate.communityId,
              input.userId
            ),
            approveUser,
          ]).then(() => {
            addQueue('private channel request approved', {
              userId: input.userId,
              channelId: channelToEvaluate.id,
              communityId: channelToEvaluate.communityId,
              moderatorId: currentUser.id,
            });
            return channelToEvaluate;
          });
        }
      }
    },
    unblockUser: async (
      _: any,
      { input }: { input: UnblockInput },
      { user }: GraphQLContext
    ) => {
      const currentUser = user;

      // user must be authed to edit a channel
      if (!currentUser) {
        return new UserError(
          'You must be signed in to make changes to this channel.'
        );
      }

      // get the current user's permission in the channel
      const getCurrentUserChannelPermissions = getUserPermissionsInChannel(
        input.channelId,
        currentUser.id
      );

      const getEvaluatedUserChannelPermissions = getUserPermissionsInChannel(
        input.channelId,
        input.userId
      );

      // get the channel being edited
      const getChannelRecords = getChannels([input.channelId]);

      const [
        currentUserChannelPermissions,
        evaluatedUserChannelPermissions,
        channels,
      ] = await Promise.all([
        getCurrentUserChannelPermissions,
        getEvaluatedUserChannelPermissions,
        getChannelRecords,
      ]);

      // get the channel to evaluate
      const channelToEvaluate = channels[0];

      // if channel wasn't found or was deleted
      if (!channelToEvaluate || channelToEvaluate.deletedAt) {
        return new UserError("This channel doesn't exist");
      }

      const currentUserCommunityPermissions = getUserPermissionsInCommunity(
        channelToEvaluate.communityId,
        currentUser.id
      );

      if (!evaluatedUserChannelPermissions.isBlocked) {
        return new UserError(
          'This user is not currently blocked in this channel.'
        );
      }

      // if a user owns the community or owns the channel, they can make this change
      if (
        currentUserChannelPermissions.isOwner ||
        currentUserCommunityPermissions.isOwner
      ) {
        return unblockMemberInChannel(input.channelId, input.userId).then(
          () => channelToEvaluate
        );
      }

      // user is neither a community or channel owner, they don't have permission
      return new UserError(
        "You don't have permission to make changes to this channel."
      );
    },
    sendChannelEmailInvites: async (
      _: any,
      { input }: { input: EmailInvitesInput },
      { user }: GraphQLContext
    ) => {
      const currentUser = user;

      if (!currentUser) {
        return new UserError(
          'You must be signed in to invite people to this channel.'
        );
      }

      // make sure the user is the owner of the channel
      const permissions = await getUserPermissionsInChannel(
        input.id,
        currentUser.id
      );

      if (!permissions.isOwner) {
        return new UserError(
          "You don't have permission to invite people to this channel."
        );
      }

      return (
        input.contacts
          // can't invite yourself
          .filter(contact => contact.email !== currentUser.email)
          .map(contact => {
            return addQueue('private channel invite notification', {
              recipient: {
                email: contact.email,
                firstName: contact.firstName ? contact.firstName : null,
                lastName: contact.lastName ? contact.lastName : null,
              },
              channelId: input.id,
              senderId: currentUser.id,
              customMessage: input.customMessage ? input.customMessage : null,
            });
          })
      );
    },
  },
};